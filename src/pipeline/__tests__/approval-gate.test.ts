import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FeedbackRecord } from '../../types/index.js';

vi.mock('../../utils/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// We need to mock process.cwd() so that approval-gate writes to our temp dir
let tempDir: string;

vi.mock('node:process', async () => {
  const actual = await vi.importActual<typeof import('node:process')>('node:process');
  return {
    ...actual,
    default: {
      ...actual,
      cwd: () => tempDir,
    },
  };
});

// Re-mock resolve so STATE_BASE uses our tempDir
// Instead, override process.cwd at module level
const originalCwd = process.cwd;

describe('approval-gate', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'printpilot-approval-'));
    process.cwd = () => tempDir;
    vi.resetModules();
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('createPendingApproval creates correct file structure', async () => {
    const { createPendingApproval } = await import('../approval-gate.js');
    await createPendingApproval('prod-001');

    const filePath = join(tempDir, 'state/products/prod-001/approval.json');
    const raw = await readFile(filePath, 'utf-8');
    const data = JSON.parse(raw);

    expect(data.productId).toBe('prod-001');
    expect(data.status).toBe('pending');
    expect(data.submittedAt).toBeDefined();
  });

  it('checkApproval returns pending for new approvals', async () => {
    const { createPendingApproval, checkApproval } = await import('../approval-gate.js');
    await createPendingApproval('prod-002');

    const status = await checkApproval('prod-002');
    expect(status).toBe('pending');
  });

  it('submitApproval with approve updates status correctly', async () => {
    const { createPendingApproval, submitApproval, checkApproval } = await import(
      '../approval-gate.js'
    );
    await createPendingApproval('prod-003');
    await submitApproval('prod-003', 'approve');

    const status = await checkApproval('prod-003');
    expect(status).toBe('approved');
  });

  it('submitApproval with reject updates status correctly', async () => {
    const { createPendingApproval, submitApproval, checkApproval } = await import(
      '../approval-gate.js'
    );
    await createPendingApproval('prod-004');
    await submitApproval('prod-004', 'reject');

    const status = await checkApproval('prod-004');
    expect(status).toBe('rejected');
  });

  it('submitApproval with revise includes feedback', async () => {
    const { createPendingApproval, submitApproval } = await import('../approval-gate.js');
    await createPendingApproval('prod-005');

    const feedback: FeedbackRecord = {
      id: 'fb-001',
      productId: 'prod-005',
      layout: 3,
      typography: 4,
      color: 2,
      differentiation: 3,
      sellability: 3,
      issues: 'Colors need adjustment',
      source: 'design',
      decision: 'revise',
      createdAt: new Date().toISOString(),
    };

    await submitApproval('prod-005', 'revise', feedback);

    const filePath = join(tempDir, 'state/products/prod-005/approval.json');
    const raw = await readFile(filePath, 'utf-8');
    const data = JSON.parse(raw);

    expect(data.status).toBe('revision-requested');
    expect(data.feedback).toBeDefined();
    expect(data.feedback.issues).toBe('Colors need adjustment');
  });

  it('checkApproval returns pending when no approval record exists', async () => {
    const { checkApproval } = await import('../approval-gate.js');
    const status = await checkApproval('nonexistent-product');
    expect(status).toBe('pending');
  });
});
