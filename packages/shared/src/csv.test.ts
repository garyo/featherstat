import { describe, expect, it } from 'vitest';
import { resultToCsv } from './csv.ts';
import type { Query, QueryResult, ResultRow } from './index.ts';

/**
 * Byte-exact goldens per query shape (the plan's CSV ratchet): the file format
 * is a contract with scripts we never see, so a change to any byte here is a
 * breaking change to someone's importer and must look like one in review.
 */

const metricQuery = (extra: Partial<Query> = {}): Query =>
  ({ id: 'q', metrics: ['visitors', 'pageviews'], ...extra }) as Query;

describe('resultToCsv', () => {
  it('totals: metric columns in request order, CRLF, trailing newline', () => {
    const result: QueryResult = { rows: [{ visitors: 3, pageviews: 7 }] };
    expect(resultToCsv(metricQuery(), result)).toBe('visitors,pageviews\r\n3,7\r\n');
  });

  it('bucketed: bucket leads, sparse rows stay sparse — a missing cell is empty, never 0', () => {
    const result: QueryResult = {
      rows: [
        { bucket: '2023-11-14', visitors: 3, pageviews: 7 },
        { bucket: '2023-11-16', visitors: 1 },
      ],
    };
    expect(resultToCsv(metricQuery({ bucket: 'day' }), result)).toBe(
      'bucket,visitors,pageviews\r\n2023-11-14,3,7\r\n2023-11-16,1,\r\n',
    );
  });

  it('dim: the header is the vocabulary word, null groups read as empty fields', () => {
    const result: QueryResult = {
      rows: [
        { ref_domain: 'news.ycombinator.com', visitors: 5, pageviews: 9 },
        { ref_domain: null, visitors: 2, pageviews: 2 },
      ],
    };
    expect(resultToCsv(metricQuery({ dim: 'ref_domain' }), result)).toBe(
      'ref_domain,visitors,pageviews\r\nnews.ycombinator.com,5,9\r\n,2,2\r\n',
    );
  });

  it('dim × bucket: compiler order — bucket first, then the dimension', () => {
    const result: QueryResult = {
      rows: [{ bucket: '2023-11-14', path: '/a', visitors: 1, pageviews: 2 }],
    };
    expect(resultToCsv(metricQuery({ dim: 'path', bucket: 'day' }), result)).toBe(
      'bucket,path,visitors,pageviews\r\n2023-11-14,/a,1,2\r\n',
    );
  });

  it('compare: a period column is prepended and compare rows append after current', () => {
    const result: QueryResult = {
      rows: [{ visitors: 3, pageviews: 7 }],
      compare: [{ visitors: 2, pageviews: 4 }],
    };
    expect(resultToCsv(metricQuery(), result)).toBe(
      'period,visitors,pageviews\r\ncurrent,3,7\r\nprevious,2,4\r\n',
    );
  });

  it('rates stay fractions in 0–1, exactly as measures declare them', () => {
    const query = metricQuery({ metrics: ['visits', 'bounce_rate'] });
    const result: QueryResult = { rows: [{ visits: 4, bounce_rate: 0.25 }] };
    expect(resultToCsv(query, result)).toBe('visits,bounce_rate\r\n4,0.25\r\n');
  });

  it('dwell: the kind’s natural columns in their served order', () => {
    const query: Query = { id: 'd', kind: 'dwell', limit: 10 };
    const result: QueryResult = {
      rows: [
        {
          path: '/post',
          views_measured: 12,
          avg_page_ms: 31000,
          max_page_ms: 90000,
          views_scrolled: 8,
          avg_scroll_pct: 0.6,
        },
      ],
    };
    expect(resultToCsv(query, result)).toBe(
      'path,views_measured,avg_page_ms,max_page_ms,views_scrolled,avg_scroll_pct\r\n' +
        '/post,12,31000,90000,8,0.6\r\n',
    );
  });

  it('flows: the signature joins with " > " into one steps column', () => {
    const query: Query = { id: 'f', kind: 'flows', steps: 4, limit: 20 };
    const result: QueryResult = {
      rows: [
        { steps: ['/', '/pricing', '/signup'], sessions: 9, avg_engaged_ms: 42000, exit_rate: 0.5 },
      ],
    };
    expect(resultToCsv(query, result)).toBe(
      'steps,sessions,avg_engaged_ms,exit_rate\r\n/ > /pricing > /signup,9,42000,0.5\r\n',
    );
  });

  it('extra row columns (a derived metric’s components) follow the request, sorted', () => {
    const query = metricQuery({ metrics: ['d:cvr'] });
    const result: QueryResult = { rows: [{ 'd:cvr': 0.1, events: 1, pageviews: 10 }] };
    expect(resultToCsv(query, result)).toBe('d:cvr,events,pageviews\r\n0.1,1,10\r\n');
  });

  it('quotes visitor-controlled text containing quote, comma and newline (RFC 4180)', () => {
    const result: QueryResult = { rows: [{ path: '/a"b,c\nd', visitors: 1, pageviews: 1 }] };
    expect(resultToCsv(metricQuery({ dim: 'path' }), result)).toBe(
      'path,visitors,pageviews\r\n"/a""b,c\nd",1,1\r\n',
    );
  });

  it('emits a leading = verbatim — pure RFC 4180, no spreadsheet escaping (see csv.ts)', () => {
    const result: QueryResult = { rows: [{ path: '=1+2', visitors: 1, pageviews: 1 }] };
    expect(resultToCsv(metricQuery({ dim: 'path' }), result)).toBe(
      'path,visitors,pageviews\r\n=1+2,1,1\r\n',
    );
  });

  it('round-trips hostile strings through an RFC 4180 parser (quoting property)', () => {
    // Deterministic hostility: every combination of the characters that force
    // quoting, in every position, plus a benign alphabet to separate them.
    const pieces = ['"', ',', '\n', '\r', '\r\n', '""', 'plain', '=cmd', ' pad ', ''];
    const values: string[] = [];
    for (const a of pieces) {
      for (const b of pieces) values.push(`${a}x${b}`);
    }
    const rows: ResultRow[] = values.map((path) => ({ path, visitors: 1 }));
    const csv = resultToCsv(metricQuery({ dim: 'path', metrics: ['visitors'] }), { rows });
    const parsed = parseCsv(csv);
    expect(parsed[0]).toEqual(['path', 'visitors']);
    expect(parsed.slice(1).map((row) => row[0])).toEqual(values);
  });
});

/** A minimal strict RFC 4180 reader — records end CRLF, quoted fields double their quotes. */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let fieldText = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      i += 1;
      for (;;) {
        if (text[i] === '"' && text[i + 1] === '"') {
          fieldText += '"';
          i += 2;
        } else if (text[i] === '"') {
          i += 1;
          break;
        } else {
          fieldText += text[i];
          i += 1;
        }
      }
    } else if (text[i] === ',') {
      record.push(fieldText);
      fieldText = '';
      i += 1;
    } else if (text[i] === '\r' && text[i + 1] === '\n') {
      record.push(fieldText);
      records.push(record);
      record = [];
      fieldText = '';
      i += 2;
    } else {
      fieldText += text[i];
      i += 1;
    }
  }
  return records;
}
