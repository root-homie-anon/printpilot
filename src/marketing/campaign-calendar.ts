import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import logger from '../utils/logger.js';
import { logActivity } from '../tracker/activity-log.js';
import { PinterestClient } from './pinterest.js';
import { EmailClient } from './email.js';
import { BlogClient } from './blog.js';
import { PromotionsEngine } from './promotions.js';
import { getEnvOrThrow } from '../utils/env.js';

// ── Constants ────────────────────────────────────────────────────────

const STATE_DIR = resolve(process.cwd(), 'state/marketing/campaigns');
const TEMPLATES_DIR = resolve(process.cwd(), 'state/marketing/campaigns/templates');

// ── Types ────────────────────────────────────────────────────────────

export type CampaignType = 'seasonal' | 'product-launch' | 'flash' | 'evergreen';
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed' | 'cancelled';

export type CampaignActionChannel = 'pinterest' | 'email' | 'blog' | 'etsy';
export type CampaignActionType =
  | 'create-pins'
  | 'send-email'
  | 'publish-blog'
  | 'apply-discount'
  | 'update-listings';
export type CampaignActionStatus =
  | 'scheduled'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface CampaignChannels {
  pinterest: boolean;
  email: boolean;
  blog: boolean;
}

export interface CampaignDateRange {
  start: string;
  end: string;
}

export interface CampaignAction {
  id: string;
  campaignId: string;
  channel: CampaignActionChannel;
  type: CampaignActionType;
  scheduledAt: string;
  executedAt?: string;
  status: CampaignActionStatus;
  content: Record<string, string>;
}

export interface Campaign {
  id: string;
  name: string;
  type: CampaignType;
  dateRange: CampaignDateRange;
  channels: CampaignChannels;
  niches: string[];
  status: CampaignStatus;
  actions: CampaignAction[];
  createdAt: string;
  updatedAt: string;
}

export interface CampaignTemplateAction {
  dayOffset: number;
  channel: CampaignActionChannel;
  type: CampaignActionType;
  label: string;
}

export interface CampaignTemplate {
  name: string;
  daysBeforeEvent: number;
  channels: CampaignChannels;
  actionSequence: CampaignTemplateAction[];
  niches: string[];
}

export interface CalendarDay {
  date: string;
  campaigns: CalendarDayCampaign[];
}

export interface CalendarDayCampaign {
  campaignId: string;
  campaignName: string;
  type: CampaignType;
  status: CampaignStatus;
  actions: CampaignAction[];
}

export interface CalendarView {
  month: number;
  year: number;
  days: CalendarDay[];
}

export interface CampaignConflict {
  campaignA: string;
  campaignB: string;
  niche: string;
  channel: CampaignActionChannel;
  overlapStart: string;
  overlapEnd: string;
}

export interface CampaignMetrics {
  campaignId: string;
  campaignName: string;
  type: CampaignType;
  status: CampaignStatus;
  totalActions: number;
  completedActions: number;
  failedActions: number;
  pendingActions: number;
  channelBreakdown: Record<CampaignActionChannel, { total: number; completed: number; failed: number }>;
}

// ── Errors ───────────────────────────────────────────────────────────

export class CampaignCalendarError extends Error {
  public readonly campaignId?: string;

  constructor(message: string, campaignId?: string) {
    super(
      campaignId
        ? `Campaign calendar error (${campaignId}): ${message}`
        : `Campaign calendar error: ${message}`
    );
    this.name = 'CampaignCalendarError';
    this.campaignId = campaignId;
  }
}

// ── Pre-built Campaign Templates ─────────────────────────────────────

const PRODUCT_LAUNCH_TEMPLATE: CampaignTemplate = {
  name: 'product-launch',
  daysBeforeEvent: 0,
  channels: { pinterest: true, email: true, blog: true },
  actionSequence: [
    { dayOffset: 0, channel: 'pinterest', type: 'create-pins', label: 'Launch day pins' },
    { dayOffset: 0, channel: 'email', type: 'send-email', label: 'Launch announcement email' },
    { dayOffset: 3, channel: 'blog', type: 'publish-blog', label: 'Product blog post' },
    { dayOffset: 7, channel: 'email', type: 'send-email', label: 'Follow-up email' },
  ],
  niches: [],
};

const SEASONAL_SALE_TEMPLATE: CampaignTemplate = {
  name: 'seasonal-sale',
  daysBeforeEvent: 7,
  channels: { pinterest: true, email: true, blog: false },
  actionSequence: [
    { dayOffset: -7, channel: 'email', type: 'send-email', label: 'Teaser email' },
    { dayOffset: 0, channel: 'etsy', type: 'apply-discount', label: 'Discount goes live' },
    { dayOffset: 0, channel: 'pinterest', type: 'create-pins', label: 'Sale announcement pins' },
    { dayOffset: 0, channel: 'email', type: 'send-email', label: 'Sale announcement email blast' },
    { dayOffset: 7, channel: 'email', type: 'send-email', label: 'Midpoint reminder email' },
    { dayOffset: -1, channel: 'email', type: 'send-email', label: 'Last day urgency email' },
  ],
  niches: [],
};

const FLASH_SALE_TEMPLATE: CampaignTemplate = {
  name: 'flash-sale',
  daysBeforeEvent: 0,
  channels: { pinterest: true, email: true, blog: true },
  actionSequence: [
    { dayOffset: 0, channel: 'pinterest', type: 'create-pins', label: 'Flash sale pins' },
    { dayOffset: 0, channel: 'email', type: 'send-email', label: 'Flash sale email blast' },
    { dayOffset: 0, channel: 'blog', type: 'publish-blog', label: 'Flash sale blog post' },
    { dayOffset: 0, channel: 'etsy', type: 'apply-discount', label: 'Flash discount live' },
  ],
  niches: [],
};

const EVERGREEN_TEMPLATE: CampaignTemplate = {
  name: 'evergreen',
  daysBeforeEvent: 0,
  channels: { pinterest: true, email: false, blog: true },
  actionSequence: [
    { dayOffset: 0, channel: 'pinterest', type: 'create-pins', label: 'Monthly pins batch 1' },
    { dayOffset: 30, channel: 'pinterest', type: 'create-pins', label: 'Monthly pins batch 2' },
    { dayOffset: 60, channel: 'pinterest', type: 'create-pins', label: 'Monthly pins batch 3' },
    { dayOffset: 90, channel: 'blog', type: 'publish-blog', label: 'Quarterly blog roundup' },
    { dayOffset: 90, channel: 'pinterest', type: 'create-pins', label: 'Monthly pins batch 4' },
    { dayOffset: 120, channel: 'pinterest', type: 'create-pins', label: 'Monthly pins batch 5' },
    { dayOffset: 150, channel: 'pinterest', type: 'create-pins', label: 'Monthly pins batch 6' },
    { dayOffset: 180, channel: 'blog', type: 'publish-blog', label: 'Quarterly blog roundup' },
    { dayOffset: 180, channel: 'pinterest', type: 'create-pins', label: 'Monthly pins batch 7' },
    { dayOffset: 210, channel: 'pinterest', type: 'create-pins', label: 'Monthly pins batch 8' },
    { dayOffset: 240, channel: 'pinterest', type: 'create-pins', label: 'Monthly pins batch 9' },
    { dayOffset: 270, channel: 'blog', type: 'publish-blog', label: 'Quarterly blog roundup' },
    { dayOffset: 270, channel: 'pinterest', type: 'create-pins', label: 'Monthly pins batch 10' },
    { dayOffset: 300, channel: 'pinterest', type: 'create-pins', label: 'Monthly pins batch 11' },
    { dayOffset: 330, channel: 'pinterest', type: 'create-pins', label: 'Monthly pins batch 12' },
    { dayOffset: 360, channel: 'blog', type: 'publish-blog', label: 'Quarterly blog roundup' },
  ],
  niches: [],
};

const BUILT_IN_TEMPLATES: Record<string, CampaignTemplate> = {
  'product-launch': PRODUCT_LAUNCH_TEMPLATE,
  'seasonal-sale': SEASONAL_SALE_TEMPLATE,
  'flash-sale': FLASH_SALE_TEMPLATE,
  'evergreen': EVERGREEN_TEMPLATE,
};

// ── Seasonal Events for Auto-Scheduling ──────────────────────────────

interface SeasonalEvent {
  name: string;
  monthDay: string;
  durationDays: number;
  niches: string[];
  templateName: string;
}

const SEASONAL_EVENTS: SeasonalEvent[] = [
  {
    name: 'New Year / Goal Setting',
    monthDay: '01-01',
    durationDays: 15,
    niches: ['planner', 'tracker', 'goals-worksheet'],
    templateName: 'seasonal-sale',
  },
  {
    name: "Valentine's Day",
    monthDay: '02-14',
    durationDays: 14,
    niches: ['journal', 'planner', 'love-journal', 'couple-planner'],
    templateName: 'seasonal-sale',
  },
  {
    name: 'Tax Season',
    monthDay: '03-15',
    durationDays: 45,
    niches: ['budget-worksheet', 'expense-tracker', 'worksheet', 'savings-tracker'],
    templateName: 'seasonal-sale',
  },
  {
    name: "Mother's Day",
    monthDay: '05-11',
    durationDays: 17,
    niches: ['self-care-journal', 'mindfulness-journal', 'wellness', 'planner'],
    templateName: 'seasonal-sale',
  },
  {
    name: "Father's Day",
    monthDay: '06-15',
    durationDays: 10,
    niches: ['fitness-tracker', 'productivity-planner', 'habit-tracker', 'planner'],
    templateName: 'seasonal-sale',
  },
  {
    name: 'Back to School',
    monthDay: '08-15',
    durationDays: 45,
    niches: ['study-planner', 'academic-planner', 'homework-tracker', 'tracker', 'planner'],
    templateName: 'seasonal-sale',
  },
  {
    name: 'Black Friday',
    monthDay: '11-25',
    durationDays: 12,
    niches: [],
    templateName: 'seasonal-sale',
  },
  {
    name: 'Holiday Season',
    monthDay: '12-10',
    durationDays: 21,
    niches: ['planner', 'journal', 'tracker', 'worksheet'],
    templateName: 'seasonal-sale',
  },
];

// ── Helpers ──────────────────────────────────────────────────────────

async function ensureDirectories(): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await mkdir(TEMPLATES_DIR, { recursive: true });
}

function getCampaignPath(id: string): string {
  return join(STATE_DIR, `${id}.json`);
}

function getTemplatePath(name: string): string {
  return join(TEMPLATES_DIR, `${name}.json`);
}

async function saveCampaign(campaign: Campaign): Promise<void> {
  await ensureDirectories();
  const filePath = getCampaignPath(campaign.id);
  await writeFile(filePath, JSON.stringify(campaign, null, 2), 'utf-8');
  logger.debug(`Saved campaign ${campaign.id} (${campaign.name})`);
}

async function loadCampaign(id: string): Promise<Campaign> {
  const filePath = getCampaignPath(id);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    throw new CampaignCalendarError(`Campaign not found: ${id}`, id);
  }
  return JSON.parse(raw) as Campaign;
}

async function loadAllCampaigns(): Promise<Campaign[]> {
  await ensureDirectories();
  const campaigns: Campaign[] = [];

  let files: string[];
  try {
    files = await readdir(STATE_DIR);
  } catch {
    return campaigns;
  }

  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue;
    }
    // Skip the templates directory marker
    if (file === 'templates') {
      continue;
    }
    try {
      const raw = await readFile(join(STATE_DIR, file), 'utf-8');
      campaigns.push(JSON.parse(raw) as Campaign);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to load campaign file ${file}: ${message}`);
    }
  }

  return campaigns;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return result;
}

function addHours(date: Date, hours: number): Date {
  const result = new Date(date.getTime());
  result.setHours(result.getHours() + hours);
  return result;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dateRangesOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string
): { overlaps: boolean; overlapStart: string; overlapEnd: string } {
  const a0 = new Date(aStart).getTime();
  const a1 = new Date(aEnd).getTime();
  const b0 = new Date(bStart).getTime();
  const b1 = new Date(bEnd).getTime();

  const overlapStart = Math.max(a0, b0);
  const overlapEnd = Math.min(a1, b1);

  if (overlapStart <= overlapEnd) {
    return {
      overlaps: true,
      overlapStart: new Date(overlapStart).toISOString(),
      overlapEnd: new Date(overlapEnd).toISOString(),
    };
  }

  return { overlaps: false, overlapStart: '', overlapEnd: '' };
}

function nichesOverlap(a: string[], b: string[]): string[] {
  if (a.length === 0 || b.length === 0) {
    // Empty niches means "all" — always overlaps
    return a.length === 0 ? b : a;
  }
  const setA = new Set(a.map((n) => n.toLowerCase()));
  return b.filter((n) => setA.has(n.toLowerCase()));
}

// ── Core Class: CampaignCalendar ─────────────────────────────────────

export class CampaignCalendar {
  async createCampaign(
    template: CampaignTemplate,
    dateRange: CampaignDateRange,
    niches: string[]
  ): Promise<Campaign> {
    await ensureDirectories();

    const now = new Date();
    const campaignId = randomUUID();
    const startDate = new Date(dateRange.start);

    logger.info(
      `Creating campaign from template "${template.name}" ` +
        `(${dateRange.start} to ${dateRange.end})`
    );

    const actions: CampaignAction[] = template.actionSequence.map((step) => {
      const scheduledDate = addDays(startDate, step.dayOffset);

      // For the seasonal-sale template, the last action uses a negative
      // offset relative to the end date (-1 = last day urgency).
      // We handle negative offsets relative to end date if they would
      // result in a date before the start.
      let finalDate = scheduledDate;
      if (step.dayOffset < 0 && step.label.toLowerCase().includes('last day')) {
        finalDate = addDays(new Date(dateRange.end), step.dayOffset);
      }

      return {
        id: randomUUID(),
        campaignId,
        channel: step.channel,
        type: step.type,
        scheduledAt: finalDate.toISOString(),
        status: 'scheduled' as CampaignActionStatus,
        content: { label: step.label },
      };
    });

    const campaign: Campaign = {
      id: campaignId,
      name: `${template.name} — ${formatDate(startDate)}`,
      type: this.templateNameToType(template.name),
      dateRange,
      channels: { ...template.channels },
      niches: niches.length > 0 ? niches : template.niches,
      status: 'active',
      actions,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    await saveCampaign(campaign);

    await logActivity({
      timestamp: now.toISOString(),
      agent: 'campaign-calendar',
      action: 'campaign-created',
      productId: campaignId,
      details:
        `Created campaign "${campaign.name}" with ${actions.length} actions ` +
        `(${dateRange.start} to ${dateRange.end})`,
      duration: 0,
      success: true,
    });

    logger.info(
      `Campaign "${campaign.name}" created (${campaignId}) ` +
        `with ${actions.length} scheduled actions`
    );

    return campaign;
  }

  async createFromTemplate(
    templateName: string,
    eventDate: Date,
    niches?: string[]
  ): Promise<Campaign> {
    const template = await this.resolveTemplate(templateName);

    const startDate = addDays(eventDate, -template.daysBeforeEvent);
    const lastActionOffset = Math.max(
      ...template.actionSequence.map((a) => Math.abs(a.dayOffset)),
      0
    );
    const endDate = addDays(eventDate, lastActionOffset);

    const dateRange: CampaignDateRange = {
      start: startDate.toISOString(),
      end: endDate.toISOString(),
    };

    logger.info(
      `Creating campaign from template "${templateName}" for event date ` +
        `${formatDate(eventDate)}`
    );

    return this.createCampaign(template, dateRange, niches ?? []);
  }

  async getCalendarView(month: number, year: number): Promise<CalendarView> {
    logger.debug(`Building calendar view for ${year}-${String(month).padStart(2, '0')}`);

    const campaigns = await loadAllCampaigns();
    const days: CalendarDay[] = [];

    const daysInMonth = new Date(year, month, 0).getDate();

    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const dayStart = new Date(`${dateStr}T00:00:00.000Z`);
      const dayEnd = new Date(`${dateStr}T23:59:59.999Z`);

      const dayCampaigns: CalendarDayCampaign[] = [];

      for (const campaign of campaigns) {
        const campaignStart = new Date(campaign.dateRange.start);
        const campaignEnd = new Date(campaign.dateRange.end);

        // Check if this campaign is active on this day
        if (campaignStart <= dayEnd && campaignEnd >= dayStart) {
          const dayActions = campaign.actions.filter((action) => {
            const actionDate = new Date(action.scheduledAt);
            return actionDate >= dayStart && actionDate <= dayEnd;
          });

          dayCampaigns.push({
            campaignId: campaign.id,
            campaignName: campaign.name,
            type: campaign.type,
            status: campaign.status,
            actions: dayActions,
          });
        }
      }

      if (dayCampaigns.length > 0) {
        days.push({ date: dateStr, campaigns: dayCampaigns });
      }
    }

    return { month, year, days };
  }

  async getUpcoming(days: number): Promise<Campaign[]> {
    logger.debug(`Fetching campaigns starting in the next ${days} days`);

    const campaigns = await loadAllCampaigns();
    const now = new Date();
    const cutoff = addDays(now, days);

    return campaigns.filter((campaign) => {
      if (campaign.status === 'cancelled' || campaign.status === 'completed') {
        return false;
      }
      const start = new Date(campaign.dateRange.start);
      return start >= now && start <= cutoff;
    });
  }

  async getToday(): Promise<CampaignAction[]> {
    logger.debug('Fetching actions due today');

    const campaigns = await loadAllCampaigns();
    const now = new Date();
    const todayStr = formatDate(now);
    const dueActions: CampaignAction[] = [];

    for (const campaign of campaigns) {
      if (campaign.status !== 'active') {
        continue;
      }

      for (const action of campaign.actions) {
        if (action.status !== 'scheduled') {
          continue;
        }

        const actionDate = formatDate(new Date(action.scheduledAt));
        if (actionDate === todayStr) {
          dueActions.push(action);
        }
      }
    }

    logger.info(`Found ${dueActions.length} actions due today`);
    return dueActions;
  }

  async executeAction(actionId: string): Promise<CampaignAction> {
    logger.info(`Executing campaign action: ${actionId}`);

    const campaigns = await loadAllCampaigns();
    let targetCampaign: Campaign | undefined;
    let targetAction: CampaignAction | undefined;

    for (const campaign of campaigns) {
      const action = campaign.actions.find((a) => a.id === actionId);
      if (action) {
        targetCampaign = campaign;
        targetAction = action;
        break;
      }
    }

    if (!targetCampaign || !targetAction) {
      throw new CampaignCalendarError(`Action not found: ${actionId}`);
    }

    if (targetAction.status !== 'scheduled') {
      throw new CampaignCalendarError(
        `Action ${actionId} is not in "scheduled" status (current: ${targetAction.status})`,
        targetCampaign.id
      );
    }

    targetAction.status = 'executing';
    await saveCampaign(targetCampaign);

    try {
      await this.dispatchAction(targetAction, targetCampaign);
      targetAction.status = 'completed';
      targetAction.executedAt = new Date().toISOString();

      logger.info(
        `Action ${actionId} (${targetAction.type}) completed for ` +
          `campaign "${targetCampaign.name}"`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      targetAction.status = 'failed';
      targetAction.executedAt = new Date().toISOString();

      logger.error(
        `Action ${actionId} (${targetAction.type}) failed for ` +
          `campaign "${targetCampaign.name}": ${message}`
      );
    }

    targetCampaign.updatedAt = new Date().toISOString();
    await saveCampaign(targetCampaign);

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'campaign-calendar',
      action: `action-${targetAction.status}`,
      productId: targetCampaign.id,
      details:
        `Action "${targetAction.content.label ?? targetAction.type}" ` +
        `(${targetAction.channel}) — ${targetAction.status}`,
      duration: 0,
      success: targetAction.status === 'completed',
    });

    return targetAction;
  }

  async executeDueActions(): Promise<CampaignAction[]> {
    logger.info('Running daily campaign action executor');

    const dueActions = await this.getToday();
    const executed: CampaignAction[] = [];

    // Also pick up past-due actions that were never executed
    const campaigns = await loadAllCampaigns();
    const now = new Date();

    for (const campaign of campaigns) {
      if (campaign.status !== 'active') {
        continue;
      }

      for (const action of campaign.actions) {
        if (action.status !== 'scheduled') {
          continue;
        }

        const scheduledAt = new Date(action.scheduledAt);
        if (scheduledAt <= now) {
          // Check if already in dueActions
          const alreadyIncluded = dueActions.some((a) => a.id === action.id);
          if (!alreadyIncluded) {
            dueActions.push(action);
          }
        }
      }
    }

    for (const action of dueActions) {
      try {
        const result = await this.executeAction(action.id);
        executed.push(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to execute action ${action.id}: ${message}`);
      }
    }

    // Also check for campaigns past their end date and auto-complete them
    await this.autoCompleteCampaigns();

    logger.info(
      `Daily execution complete: ${executed.length} actions processed, ` +
        `${executed.filter((a) => a.status === 'completed').length} succeeded, ` +
        `${executed.filter((a) => a.status === 'failed').length} failed`
    );

    return executed;
  }

  async pauseCampaign(campaignId: string): Promise<Campaign> {
    logger.info(`Pausing campaign: ${campaignId}`);

    const campaign = await loadCampaign(campaignId);

    if (campaign.status !== 'active') {
      throw new CampaignCalendarError(
        `Cannot pause campaign with status "${campaign.status}"`,
        campaignId
      );
    }

    campaign.status = 'paused';
    campaign.updatedAt = new Date().toISOString();
    await saveCampaign(campaign);

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'campaign-calendar',
      action: 'campaign-paused',
      productId: campaignId,
      details: `Paused campaign "${campaign.name}"`,
      duration: 0,
      success: true,
    });

    logger.info(`Campaign "${campaign.name}" paused (${campaignId})`);
    return campaign;
  }

  async resumeCampaign(campaignId: string): Promise<Campaign> {
    logger.info(`Resuming campaign: ${campaignId}`);

    const campaign = await loadCampaign(campaignId);

    if (campaign.status !== 'paused') {
      throw new CampaignCalendarError(
        `Cannot resume campaign with status "${campaign.status}"`,
        campaignId
      );
    }

    campaign.status = 'active';
    campaign.updatedAt = new Date().toISOString();
    await saveCampaign(campaign);

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'campaign-calendar',
      action: 'campaign-resumed',
      productId: campaignId,
      details: `Resumed campaign "${campaign.name}"`,
      duration: 0,
      success: true,
    });

    logger.info(`Campaign "${campaign.name}" resumed (${campaignId})`);
    return campaign;
  }

  async cancelCampaign(campaignId: string): Promise<Campaign> {
    logger.info(`Cancelling campaign: ${campaignId}`);

    const campaign = await loadCampaign(campaignId);

    if (campaign.status === 'completed' || campaign.status === 'cancelled') {
      throw new CampaignCalendarError(
        `Cannot cancel campaign with status "${campaign.status}"`,
        campaignId
      );
    }

    // Cancel all pending actions
    let cancelledCount = 0;
    for (const action of campaign.actions) {
      if (action.status === 'scheduled') {
        action.status = 'cancelled';
        cancelledCount++;
      }
    }

    campaign.status = 'cancelled';
    campaign.updatedAt = new Date().toISOString();
    await saveCampaign(campaign);

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'campaign-calendar',
      action: 'campaign-cancelled',
      productId: campaignId,
      details:
        `Cancelled campaign "${campaign.name}" — ` +
        `${cancelledCount} pending actions cancelled`,
      duration: 0,
      success: true,
    });

    logger.info(
      `Campaign "${campaign.name}" cancelled (${campaignId}), ` +
        `${cancelledCount} actions cancelled`
    );

    return campaign;
  }

  async getCampaignMetrics(campaignId: string): Promise<CampaignMetrics> {
    logger.info(`Fetching metrics for campaign: ${campaignId}`);

    const campaign = await loadCampaign(campaignId);

    const channelBreakdown: Record<
      CampaignActionChannel,
      { total: number; completed: number; failed: number }
    > = {
      pinterest: { total: 0, completed: 0, failed: 0 },
      email: { total: 0, completed: 0, failed: 0 },
      blog: { total: 0, completed: 0, failed: 0 },
      etsy: { total: 0, completed: 0, failed: 0 },
    };

    let completedActions = 0;
    let failedActions = 0;
    let pendingActions = 0;

    for (const action of campaign.actions) {
      const channelStats = channelBreakdown[action.channel];
      channelStats.total++;

      switch (action.status) {
        case 'completed':
          completedActions++;
          channelStats.completed++;
          break;
        case 'failed':
          failedActions++;
          channelStats.failed++;
          break;
        case 'scheduled':
        case 'executing':
          pendingActions++;
          break;
        case 'cancelled':
          // Not counted in pending
          break;
      }
    }

    return {
      campaignId,
      campaignName: campaign.name,
      type: campaign.type,
      status: campaign.status,
      totalActions: campaign.actions.length,
      completedActions,
      failedActions,
      pendingActions,
      channelBreakdown,
    };
  }

  async autoScheduleYear(year: number): Promise<Campaign[]> {
    logger.info(`Auto-scheduling seasonal campaigns for year ${year}`);

    const created: Campaign[] = [];
    const existing = await loadAllCampaigns();
    const existingNames = new Set(existing.map((c) => c.name));

    for (const event of SEASONAL_EVENTS) {
      const campaignName = `${event.name} ${year}`;

      if (existingNames.has(campaignName)) {
        logger.info(`Campaign "${campaignName}" already exists, skipping`);
        continue;
      }

      const [month, day] = event.monthDay.split('-').map(Number);
      const eventDate = new Date(year, month - 1, day);

      const template = await this.resolveTemplate(event.templateName);
      const startDate = addDays(eventDate, -template.daysBeforeEvent);
      const endDate = addDays(eventDate, event.durationDays);

      const dateRange: CampaignDateRange = {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      };

      try {
        const campaign = await this.createCampaign(
          template,
          dateRange,
          event.niches
        );

        // Override the auto-generated name with the seasonal name
        campaign.name = campaignName;
        await saveCampaign(campaign);

        created.push(campaign);
        logger.info(`Auto-scheduled campaign: ${campaignName}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to auto-schedule "${campaignName}": ${message}`);
      }
    }

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'campaign-calendar',
      action: 'year-auto-scheduled',
      productId: String(year),
      details:
        `Auto-scheduled ${created.length} seasonal campaigns for ${year}`,
      duration: 0,
      success: true,
    });

    logger.info(
      `Auto-schedule complete for ${year}: ${created.length} campaigns created`
    );

    return created;
  }

  async checkConflicts(campaign: Campaign): Promise<CampaignConflict[]> {
    logger.debug(`Checking conflicts for campaign "${campaign.name}"`);

    const existing = await loadAllCampaigns();
    const conflicts: CampaignConflict[] = [];

    for (const other of existing) {
      // Skip self, cancelled, and completed campaigns
      if (
        other.id === campaign.id ||
        other.status === 'cancelled' ||
        other.status === 'completed'
      ) {
        continue;
      }

      // Check date range overlap
      const overlap = dateRangesOverlap(
        campaign.dateRange.start,
        campaign.dateRange.end,
        other.dateRange.start,
        other.dateRange.end
      );

      if (!overlap.overlaps) {
        continue;
      }

      // Check niche overlap
      const sharedNiches = nichesOverlap(campaign.niches, other.niches);
      if (sharedNiches.length === 0) {
        continue;
      }

      // Check channel overlap
      const channels: CampaignActionChannel[] = ['pinterest', 'email', 'blog'];
      for (const channel of channels) {
        const key = channel as keyof CampaignChannels;
        if (campaign.channels[key] && other.channels[key]) {
          for (const niche of sharedNiches) {
            conflicts.push({
              campaignA: campaign.id,
              campaignB: other.id,
              niche,
              channel,
              overlapStart: overlap.overlapStart,
              overlapEnd: overlap.overlapEnd,
            });
          }
        }
      }
    }

    if (conflicts.length > 0) {
      logger.warn(
        `Found ${conflicts.length} conflicts for campaign "${campaign.name}"`
      );
    } else {
      logger.debug(`No conflicts found for campaign "${campaign.name}"`);
    }

    return conflicts;
  }

  // ── Template Management ─────────────────────────────────────────────

  async saveTemplate(template: CampaignTemplate): Promise<void> {
    await ensureDirectories();
    const filePath = getTemplatePath(template.name);
    await writeFile(filePath, JSON.stringify(template, null, 2), 'utf-8');
    logger.info(`Saved campaign template: ${template.name}`);
  }

  async loadTemplate(name: string): Promise<CampaignTemplate> {
    // Check built-in first
    if (BUILT_IN_TEMPLATES[name]) {
      return BUILT_IN_TEMPLATES[name];
    }

    // Try custom template on disk
    const filePath = getTemplatePath(name);
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch {
      throw new CampaignCalendarError(`Template not found: ${name}`);
    }
    return JSON.parse(raw) as CampaignTemplate;
  }

  async listTemplates(): Promise<string[]> {
    const builtIn = Object.keys(BUILT_IN_TEMPLATES);

    let customFiles: string[];
    try {
      customFiles = await readdir(TEMPLATES_DIR);
    } catch {
      return builtIn;
    }

    const custom = customFiles
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace('.json', ''));

    // Deduplicate
    const all = new Set([...builtIn, ...custom]);
    return Array.from(all);
  }

  // ── Private Helpers ─────────────────────────────────────────────────

  private async resolveTemplate(name: string): Promise<CampaignTemplate> {
    if (BUILT_IN_TEMPLATES[name]) {
      return { ...BUILT_IN_TEMPLATES[name] };
    }
    return this.loadTemplate(name);
  }

  private templateNameToType(name: string): CampaignType {
    if (name.includes('seasonal') || name.includes('sale')) {
      return 'seasonal';
    }
    if (name.includes('launch') || name.includes('product')) {
      return 'product-launch';
    }
    if (name.includes('flash')) {
      return 'flash';
    }
    return 'evergreen';
  }

  private async dispatchAction(
    action: CampaignAction,
    campaign: Campaign
  ): Promise<void> {
    logger.info(
      `Dispatching ${action.type} on ${action.channel} for ` +
        `campaign "${campaign.name}"`
    );

    switch (action.type) {
      case 'create-pins':
        await this.executePinterestAction(action, campaign);
        break;
      case 'send-email':
        await this.executeEmailAction(action, campaign);
        break;
      case 'publish-blog':
        await this.executeBlogAction(action, campaign);
        break;
      case 'apply-discount':
        await this.executeDiscountAction(action, campaign);
        break;
      case 'update-listings':
        await this.executeListingUpdateAction(action, campaign);
        break;
      default: {
        const exhaustive: never = action.type;
        throw new CampaignCalendarError(
          `Unknown action type: ${exhaustive as string}`,
          campaign.id
        );
      }
    }
  }

  private async executePinterestAction(
    action: CampaignAction,
    campaign: Campaign
  ): Promise<void> {
    const accessToken = getEnvOrThrow('PINTEREST_ACCESS_TOKEN');
    const client = new PinterestClient(accessToken);

    const nicheLabel = campaign.niches.length > 0
      ? campaign.niches.join(', ')
      : 'all niches';

    // Create a campaign-themed pin
    await client.createPin({
      title: `${campaign.name} — ${action.content.label ?? 'Campaign Pin'}`,
      description:
        `Check out our ${nicheLabel} collection! ` +
        `${campaign.name} is happening now.`,
      imageUrl: action.content.imageUrl ?? '',
      link: action.content.link ?? '',
      boardId: action.content.boardId ?? '',
    });

    logger.info(
      `Pinterest pin created for campaign "${campaign.name}" ` +
        `(${action.content.label ?? action.type})`
    );
  }

  private async executeEmailAction(
    action: CampaignAction,
    campaign: Campaign
  ): Promise<void> {
    const providerName = getEnvOrThrow('EMAIL_PROVIDER');
    const apiKey = getEnvOrThrow('EMAIL_API_KEY');
    const listId = getEnvOrThrow('EMAIL_LIST_ID');

    const client = new EmailClient(
      providerName as 'resend' | 'convertkit' | 'mailchimp',
      apiKey
    );

    const nicheLabel = campaign.niches.length > 0
      ? campaign.niches.join(', ')
      : 'our full collection';

    await client.sendCampaign({
      subject: action.content.subject ?? `${campaign.name} — ${action.content.label ?? 'Update'}`,
      htmlBody:
        action.content.htmlBody ??
        `<h1>${campaign.name}</h1><p>${action.content.label ?? 'Check out our latest offerings!'}</p>`,
      textBody:
        action.content.textBody ??
        `${campaign.name} — ${action.content.label ?? 'Check out our latest offerings!'}`,
      listId,
      tags: [campaign.type, ...campaign.niches],
    });

    logger.info(
      `Email sent for campaign "${campaign.name}" ` +
        `(${action.content.label ?? action.type})`
    );
  }

  private async executeBlogAction(
    action: CampaignAction,
    campaign: Campaign
  ): Promise<void> {
    const platform = getEnvOrThrow('BLOG_PLATFORM');
    const apiUrl = getEnvOrThrow('BLOG_API_URL');
    const apiKey = getEnvOrThrow('BLOG_API_KEY');

    const client = new BlogClient(
      platform as 'wordpress' | 'ghost',
      apiUrl,
      apiKey
    );

    const slug = campaign.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');

    await client.publishPost({
      title: action.content.title ?? `${campaign.name} — ${action.content.label ?? 'Blog Post'}`,
      content:
        action.content.content ??
        `<p>Discover our ${campaign.niches.join(', ') || 'full'} collection during ${campaign.name}.</p>`,
      excerpt:
        action.content.excerpt ??
        `${campaign.name} is here! Explore our curated collection.`,
      tags: [campaign.type, ...campaign.niches],
      featuredImageUrl: action.content.featuredImageUrl ?? '',
      slug: action.content.slug ?? slug,
    });

    logger.info(
      `Blog post published for campaign "${campaign.name}" ` +
        `(${action.content.label ?? action.type})`
    );
  }

  private async executeDiscountAction(
    action: CampaignAction,
    campaign: Campaign
  ): Promise<void> {
    const engine = new PromotionsEngine();

    const discountPercent = action.content.discountPercent
      ? parseInt(action.content.discountPercent, 10)
      : 15;

    await engine.createCoupon({
      discountPercent,
      prefix: campaign.name.replace(/[^a-zA-Z]/g, '').substring(0, 8).toUpperCase(),
      startDate: campaign.dateRange.start,
      endDate: campaign.dateRange.end,
      campaignName: campaign.name,
    });

    logger.info(
      `Discount applied for campaign "${campaign.name}" ` +
        `(${discountPercent}% off)`
    );
  }

  private async executeListingUpdateAction(
    _action: CampaignAction,
    campaign: Campaign
  ): Promise<void> {
    // Listing updates are a placeholder for future Etsy listing
    // modification capabilities (e.g., updating tags, titles, or images
    // to align with campaign themes).
    logger.info(
      `Listing update action queued for campaign "${campaign.name}" ` +
        '(not yet implemented — placeholder for Etsy listing API integration)'
    );
  }

  private async autoCompleteCampaigns(): Promise<void> {
    const campaigns = await loadAllCampaigns();
    const now = new Date();

    for (const campaign of campaigns) {
      if (campaign.status !== 'active') {
        continue;
      }

      const endDate = new Date(campaign.dateRange.end);
      if (endDate >= now) {
        continue;
      }

      // Check if all actions are either completed, failed, or cancelled
      const allDone = campaign.actions.every(
        (a) =>
          a.status === 'completed' ||
          a.status === 'failed' ||
          a.status === 'cancelled'
      );

      if (allDone) {
        campaign.status = 'completed';
        campaign.updatedAt = now.toISOString();
        await saveCampaign(campaign);

        await logActivity({
          timestamp: now.toISOString(),
          agent: 'campaign-calendar',
          action: 'campaign-auto-completed',
          productId: campaign.id,
          details: `Auto-completed campaign "${campaign.name}" (past end date, all actions done)`,
          duration: 0,
          success: true,
        });

        logger.info(`Auto-completed campaign "${campaign.name}" (${campaign.id})`);
      }
    }
  }
}
