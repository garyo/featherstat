import type {
  AdminDataSettings,
  AdminPropsResponse,
  AlertRule,
  AnnotationCreate,
  AnnotationInfo,
  ApiTokenCreate,
  ApiTokenInfo,
  ApiTokenMinted,
  CampaignAlias,
  CampaignCreate,
  CampaignInfo,
  DerivedMetricCreate,
  DerivedMetricInfo,
  GoalCreate,
  GoalInfo,
  MagicLinkMinted,
  SegmentCreate,
  SegmentInfo,
  ViewerInfo,
  ViewerInvite,
} from '@featherstat/shared';
import type { AdminClient } from './admin.ts';

/**
 * The admin-object surfaces the Settings panels manage (docs/04 § 5): tokens,
 * viewers, segments, derived metrics, goals, campaigns + aliases, annotations,
 * alert rules, prop governance. Deliberately a separate module from admin.ts —
 * that one rides the entry chunk (the login flow needs it), while every route
 * here is reachable only from the code-split Settings chunk, so this is where
 * the bytes belong. Built on `AdminClient.call`, which owns the CSRF echo and
 * the 401 report.
 */
export interface AdminObjects {
  listTokens(): Promise<ApiTokenInfo[]>;
  /** Mints a scoped read-only token; `token` appears here once and never again. */
  createToken(token: ApiTokenCreate): Promise<ApiTokenMinted>;
  revokeToken(id: number): Promise<void>;
  listViewers(): Promise<ViewerInfo[]>;
  /** Invite (or re-invite) an email; `url` is the single-use claim link, shown once. */
  inviteViewer(invite: ViewerInvite): Promise<MagicLinkMinted>;
  /** A fresh magic link for an existing viewer. */
  reinviteViewer(id: number): Promise<MagicLinkMinted>;
  revokeViewer(id: number): Promise<void>;
  listSegments(): Promise<SegmentInfo[]>;
  createSegment(segment: SegmentCreate): Promise<SegmentInfo>;
  updateSegment(id: number, segment: SegmentCreate): Promise<SegmentInfo>;
  deleteSegment(id: number): Promise<void>;
  listDerivedMetrics(): Promise<DerivedMetricInfo[]>;
  createDerivedMetric(metric: DerivedMetricCreate): Promise<DerivedMetricInfo>;
  updateDerivedMetric(id: number, metric: DerivedMetricCreate): Promise<DerivedMetricInfo>;
  deleteDerivedMetric(id: number): Promise<void>;
  listGoals(siteId: number): Promise<GoalInfo[]>;
  createGoal(siteId: number, goal: GoalCreate): Promise<GoalInfo>;
  updateGoal(id: number, goal: GoalCreate): Promise<GoalInfo>;
  deleteGoal(id: number): Promise<void>;
  listCampaigns(siteId: number): Promise<CampaignInfo[]>;
  createCampaign(siteId: number, campaign: CampaignCreate): Promise<CampaignInfo>;
  updateCampaign(id: number, campaign: CampaignCreate): Promise<CampaignInfo>;
  deleteCampaign(id: number): Promise<void>;
  /** Site 0 is the install-wide fallback list ingest consults second. */
  listCampaignAliases(siteId: number): Promise<CampaignAlias[]>;
  /** Full-list replace — the PUT is the whole truth for that site. */
  saveCampaignAliases(siteId: number, aliases: CampaignAlias[]): Promise<CampaignAlias[]>;
  listAnnotations(siteId?: number): Promise<AnnotationInfo[]>;
  createAnnotation(annotation: AnnotationCreate): Promise<AnnotationInfo>;
  updateAnnotation(id: number, annotation: AnnotationCreate): Promise<AnnotationInfo>;
  deleteAnnotation(id: number): Promise<void>;
  alertRules(): Promise<AlertRule[]>;
  /** Full replacement, like the ntfy rules — the list is the unit of editing. */
  saveAlertRules(rules: AlertRule[]): Promise<AlertRule[]>;
  props(siteId: number): Promise<AdminPropsResponse>;
  /** Forgets the key AND scrubs it from stored history — irreversible. */
  deletePropKey(siteId: number, key: string): Promise<void>;
  dataSettings(): Promise<AdminDataSettings>;
  /** Full replacement, like the alert rules — the three knobs travel together. */
  saveDataSettings(settings: AdminDataSettings): Promise<AdminDataSettings>;
}

export function adminObjects(admin: AdminClient): AdminObjects {
  const call = admin.call.bind(admin);
  return {
    listTokens: () => call('/api/admin/tokens'),
    createToken: (token) => call('/api/admin/tokens', { method: 'POST', body: token }),
    async revokeToken(id) {
      await call(`/api/admin/tokens/${id}`, { method: 'DELETE' });
    },
    listViewers: () => call('/api/admin/viewers'),
    inviteViewer: (invite) => call('/api/admin/viewers', { method: 'POST', body: invite }),
    reinviteViewer: (id) => call(`/api/admin/viewers/${id}/invite`, { method: 'POST' }),
    async revokeViewer(id) {
      await call(`/api/admin/viewers/${id}`, { method: 'DELETE' });
    },
    listSegments: () => call('/api/admin/segments'),
    createSegment: (segment) => call('/api/admin/segments', { method: 'POST', body: segment }),
    updateSegment: (id, segment) =>
      call(`/api/admin/segments/${id}`, { method: 'PUT', body: segment }),
    async deleteSegment(id) {
      await call(`/api/admin/segments/${id}`, { method: 'DELETE' });
    },
    listDerivedMetrics: () => call('/api/admin/derived-metrics'),
    createDerivedMetric: (metric) =>
      call('/api/admin/derived-metrics', { method: 'POST', body: metric }),
    updateDerivedMetric: (id, metric) =>
      call(`/api/admin/derived-metrics/${id}`, { method: 'PUT', body: metric }),
    async deleteDerivedMetric(id) {
      await call(`/api/admin/derived-metrics/${id}`, { method: 'DELETE' });
    },
    listGoals: (siteId) => call(`/api/admin/goals?site=${siteId}`),
    createGoal: (siteId, goal) =>
      call(`/api/admin/goals?site=${siteId}`, { method: 'POST', body: goal }),
    updateGoal: (id, goal) => call(`/api/admin/goals/${id}`, { method: 'PUT', body: goal }),
    async deleteGoal(id) {
      await call(`/api/admin/goals/${id}`, { method: 'DELETE' });
    },
    listCampaigns: (siteId) => call(`/api/admin/campaigns?site=${siteId}`),
    createCampaign: (siteId, campaign) =>
      call(`/api/admin/campaigns?site=${siteId}`, { method: 'POST', body: campaign }),
    updateCampaign: (id, campaign) =>
      call(`/api/admin/campaigns/${id}`, { method: 'PUT', body: campaign }),
    async deleteCampaign(id) {
      await call(`/api/admin/campaigns/${id}`, { method: 'DELETE' });
    },
    listCampaignAliases: (siteId) => call(`/api/admin/campaign-aliases?site=${siteId}`),
    saveCampaignAliases: (siteId, aliases) =>
      call(`/api/admin/campaign-aliases?site=${siteId}`, { method: 'PUT', body: aliases }),
    listAnnotations: (siteId) =>
      call(
        siteId === undefined ? '/api/admin/annotations' : `/api/admin/annotations?site=${siteId}`,
      ),
    createAnnotation: (annotation) =>
      call('/api/admin/annotations', { method: 'POST', body: annotation }),
    updateAnnotation: (id, annotation) =>
      call(`/api/admin/annotations/${id}`, { method: 'PUT', body: annotation }),
    async deleteAnnotation(id) {
      await call(`/api/admin/annotations/${id}`, { method: 'DELETE' });
    },
    alertRules: async () => (await call<{ rules: AlertRule[] }>('/api/admin/alerts')).rules,
    saveAlertRules: async (rules) =>
      (await call<{ rules: AlertRule[] }>('/api/admin/alerts', { method: 'PUT', body: { rules } }))
        .rules,
    props: (siteId) => call(`/api/admin/props?site=${siteId}`),
    async deletePropKey(siteId, key) {
      await call(`/api/admin/props/${siteId}/${encodeURIComponent(key)}`, { method: 'DELETE' });
    },
    dataSettings: () => call('/api/admin/data-settings'),
    saveDataSettings: (settings) =>
      call('/api/admin/data-settings', { method: 'PUT', body: settings }),
  };
}
