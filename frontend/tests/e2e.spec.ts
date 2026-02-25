/**
 * Council1901 – Playwright end-to-end tests
 *
 * Tests run against a real backend (wrangler dev on :8787) proxied through the
 * Astro dev server on :4321.  No API mocks are used.
 */

import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COUNTRY = 'england';

/** Generate a unique room ID per test to avoid KV state pollution. */
function uniqueRoomId(): string {
  return `test-room-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
}

/** Log in through the UI. */
async function loginViaUI(page: Page, roomId: string) {
  await page.fill('#room-id', roomId);
  await page.selectOption('#country-select', COUNTRY);
  await page.click('button[type="submit"]');
  await expect(page.locator('#room-screen')).toBeVisible();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Auth screen', () => {
  test('shows auth screen on first visit', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#auth-screen')).toBeVisible();
    await expect(page.locator('#room-screen')).toBeHidden();
    await expect(page.locator('#auth-screen h2')).toHaveText('Join a room');
    await page.screenshot({ path: 'test-results/01-auth-screen.png', fullPage: true });
  });

  test('shows all seven countries in the select', async ({ page }) => {
    await page.goto('/');
    const options = page.locator('#country-select option:not([value=""])');
    await expect(options).toHaveCount(7);
    const values = await options.evaluateAll((opts) =>
      (opts as HTMLOptionElement[]).map((o) => o.value),
    );
    expect(values).toEqual([
      'england', 'france', 'germany', 'italy', 'austria', 'russia', 'turkey',
    ]);
  });
});

test.describe('Room screen', () => {
  test('transitions to room screen after successful auth', async ({ page }) => {
    const roomId = uniqueRoomId();
    await page.goto('/');
    await loginViaUI(page, roomId);

    await expect(page.locator('#auth-screen')).toBeHidden();
    await expect(page.locator('#header-info')).toContainText(roomId);
    await expect(page.locator('#header-info')).toContainText('England');
    await expect(page.locator('#btn-logout')).toBeVisible();
    await page.screenshot({ path: 'test-results/03-room-screen.png', fullPage: true });
  });

  test('shows "No conversations yet" when conversation list is empty', async ({ page }) => {
    const roomId = uniqueRoomId();
    await page.goto('/');
    await loginViaUI(page, roomId);
    await expect(page.locator('#conv-list')).toContainText('No conversations yet');
  });

  test('persists session: room screen shown on reload with stored token', async ({ page }) => {
    const roomId = uniqueRoomId();
    await page.goto('/');
    await loginViaUI(page, roomId);
    await page.reload();
    await expect(page.locator('#room-screen')).toBeVisible();
    await expect(page.locator('#auth-screen')).toBeHidden();
    await page.screenshot({ path: 'test-results/04-persisted-session.png', fullPage: true });
  });

  test('logout returns to auth screen and clears state', async ({ page }) => {
    const roomId = uniqueRoomId();
    await page.goto('/');
    await loginViaUI(page, roomId);
    await page.click('#btn-logout');
    await expect(page.locator('#auth-screen')).toBeVisible();
    await expect(page.locator('#room-screen')).toBeHidden();
    const stored = await page.evaluate(() => localStorage.getItem('council1901_auth'));
    expect(stored).toBeNull();
    await page.screenshot({ path: 'test-results/05-after-logout.png', fullPage: true });
  });
});

test.describe('New conversation modal', () => {
  test('opens modal with checkboxes excluding current country', async ({ page }) => {
    const roomId = uniqueRoomId();
    await page.goto('/');
    await loginViaUI(page, roomId);
    await page.click('#btn-new-conv');

    const modal = page.locator('#new-conv-modal');
    await expect(modal).toHaveClass(/open/);

    const checkboxes = modal.locator('input[type="checkbox"]');
    await expect(checkboxes).toHaveCount(6);
    const values = await checkboxes.evaluateAll((cbs) =>
      (cbs as HTMLInputElement[]).map((c) => c.value),
    );
    expect(values).not.toContain('england');
    await page.screenshot({ path: 'test-results/06-new-conv-modal.png', fullPage: true });
  });

  test('shows validation error when no country is checked', async ({ page }) => {
    const roomId = uniqueRoomId();
    await page.goto('/');
    await loginViaUI(page, roomId);
    await page.click('#btn-new-conv');
    await page.click('#btn-modal-create');
    await expect(page.locator('#modal-error')).toContainText('Select 1 or 2 other countries');
    await page.screenshot({ path: 'test-results/07-modal-validation.png', fullPage: true });
  });

  test('cancel button closes the modal', async ({ page }) => {
    const roomId = uniqueRoomId();
    await page.goto('/');
    await loginViaUI(page, roomId);
    await page.click('#btn-new-conv');
    await expect(page.locator('#new-conv-modal')).toHaveClass(/open/);
    await page.click('#btn-modal-cancel');
    await expect(page.locator('#new-conv-modal')).not.toHaveClass(/open/);
  });

  test('clicking outside modal closes it', async ({ page }) => {
    const roomId = uniqueRoomId();
    await page.goto('/');
    await loginViaUI(page, roomId);
    await page.click('#btn-new-conv');
    await page.locator('#new-conv-modal').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('#new-conv-modal')).not.toHaveClass(/open/);
  });
});

test.describe('Conversation flow', () => {
  test('creates conversation and shows chat area', async ({ page }) => {
    const roomId = uniqueRoomId();
    await page.goto('/');
    await loginViaUI(page, roomId);

    await page.click('#btn-new-conv');
    await page.check('input[value="france"]');
    await page.click('#btn-modal-create');

    await expect(page.locator('#new-conv-modal')).not.toHaveClass(/open/);
    await expect(page.locator('#messages')).toBeVisible();
    await expect(page.locator('#send-form')).toBeVisible();
    await expect(page.locator('#chat-header')).toContainText('England');
    await expect(page.locator('#chat-header')).toContainText('France');
    await page.screenshot({ path: 'test-results/08-chat-open.png', fullPage: true });
  });

  test('conversation appears in sidebar after creation', async ({ page }) => {
    const roomId = uniqueRoomId();
    await page.goto('/');
    await loginViaUI(page, roomId);

    await page.click('#btn-new-conv');
    await page.check('input[value="france"]');
    await page.click('#btn-modal-create');

    await expect(page.locator('#conv-list .conv-item')).toContainText('France');
    await page.screenshot({ path: 'test-results/09-conv-in-sidebar.png', fullPage: true });
  });
});

test.describe('Messaging', () => {
  test('sending a message displays it in the chat', async ({ page }) => {
    const roomId = uniqueRoomId();
    await page.goto('/');
    await loginViaUI(page, roomId);

    await page.click('#btn-new-conv');
    await page.check('input[value="france"]');
    await page.click('#btn-modal-create');

    const msgText = 'Hello France, let us form an alliance!';
    await page.fill('#msg-input', msgText);
    await page.click('#send-form button[type="submit"]');

    const msgEl = page.locator('.msg.mine .msg-text');
    await expect(msgEl).toContainText(msgText);
    await page.screenshot({ path: 'test-results/10-message-sent.png', fullPage: true });
  });
});

