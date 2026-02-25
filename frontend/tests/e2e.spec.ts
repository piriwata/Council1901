/**
 * Council1901 – Playwright end-to-end tests
 *
 * All /api/* calls are intercepted with page.route() so no real backend is
 * needed.  The Astro static build is served by `astro preview` (configured in
 * playwright.config.ts) and the tests drive the full browser UI.
 */

import { test, expect, type Page, type Route } from '@playwright/test';

// ---------------------------------------------------------------------------
// Shared mock data
// ---------------------------------------------------------------------------

const ROOM_ID = 'test-room-1901';
const COUNTRY = 'england';
const FAKE_TOKEN = `${ROOM_ID}|${COUNTRY}|fakehexsignature`;
const CONV_ID = 'abcd1234abcd1234';

interface MockMessage {
  message_id: string;
  room_id: string;
  conversation_id: string;
  sender_country: string;
  content: string;
  timestamp: number;
}

interface MockConversation {
  conversation_id: string;
  participants: string[];
}

// ---------------------------------------------------------------------------
// Helper: mount standard API mocks on a page
// ---------------------------------------------------------------------------

async function setupApiMocks(
  page: Page,
  opts: {
    conversations?: MockConversation[];
    messages?: MockMessage[];
  } = {},
) {
  const conversations: MockConversation[] = opts.conversations ?? [];
  const messages: MockMessage[] = opts.messages ?? [];

  // POST /api/auth
  await page.route('**/api/auth', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ access_token: FAKE_TOKEN }),
    });
  });

  // GET /api/conversations
  await page.route('**/api/conversations*', async (route: Route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(conversations),
      });
    } else {
      // POST /api/conversations
      const newConv: MockConversation = {
        conversation_id: CONV_ID,
        participants: ['england', 'france'],
      };
      conversations.push(newConv);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ conversation_id: CONV_ID }),
      });
    }
  });

  // GET /api/messages & POST /api/messages
  await page.route('**/api/messages*', async (route: Route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(messages),
      });
    } else {
      // POST /api/messages – add the message to the list and return its id
      const body = JSON.parse(route.request().postData() ?? '{}');
      const msg: MockMessage = {
        message_id: 'msg-uuid-1',
        room_id: ROOM_ID,
        conversation_id: body.conversation_id,
        sender_country: COUNTRY,
        content: body.content,
        timestamp: 1_700_000_000_000,
      };
      messages.push(msg);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ message_id: 'msg-uuid-1' }),
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Helper: log in through the UI
// ---------------------------------------------------------------------------

async function loginViaUI(page: Page) {
  await page.fill('#room-id', ROOM_ID);
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
    await expect(page.locator('h2')).toHaveText('Join a room');
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

  test('shows error when API returns 400', async ({ page }) => {
    await page.route('**/api/auth', async (route) => {
      await route.fulfill({ status: 400, body: 'Invalid country' });
    });
    await page.goto('/');
    await page.fill('#room-id', ROOM_ID);
    await page.selectOption('#country-select', COUNTRY);
    await page.click('button[type="submit"]');
    await expect(page.locator('#auth-error')).toContainText('Invalid country');
    await page.screenshot({ path: 'test-results/02-auth-error.png', fullPage: true });
  });
});

test.describe('Room screen', () => {
  test('transitions to room screen after successful auth', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/');
    await loginViaUI(page);

    // Auth screen should be hidden
    await expect(page.locator('#auth-screen')).toBeHidden();
    // Header info should show room and country
    await expect(page.locator('#header-info')).toContainText(ROOM_ID);
    await expect(page.locator('#header-info')).toContainText('England');
    // Logout button visible
    await expect(page.locator('#btn-logout')).toBeVisible();
    await page.screenshot({ path: 'test-results/03-room-screen.png', fullPage: true });
  });

  test('shows "No conversations yet" when conversation list is empty', async ({ page }) => {
    await setupApiMocks(page, { conversations: [] });
    await page.goto('/');
    await loginViaUI(page);
    await expect(page.locator('#conv-list')).toContainText('No conversations yet');
  });

  test('persists session: room screen shown on reload with stored token', async ({ page }) => {
    await setupApiMocks(page);
    // Pre-seed localStorage to simulate a returning user
    await page.goto('/');
    await page.evaluate(
      ([key, token, roomId, country]) => {
        localStorage.setItem(key, JSON.stringify({ token, roomId, country }));
      },
      ['council1901_auth', FAKE_TOKEN, ROOM_ID, COUNTRY],
    );
    await page.reload();
    await expect(page.locator('#room-screen')).toBeVisible();
    await expect(page.locator('#auth-screen')).toBeHidden();
    await page.screenshot({ path: 'test-results/04-persisted-session.png', fullPage: true });
  });

  test('logout returns to auth screen and clears state', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/');
    await loginViaUI(page);
    await page.click('#btn-logout');
    await expect(page.locator('#auth-screen')).toBeVisible();
    await expect(page.locator('#room-screen')).toBeHidden();
    // localStorage should be cleared
    const stored = await page.evaluate(() => localStorage.getItem('council1901_auth'));
    expect(stored).toBeNull();
    await page.screenshot({ path: 'test-results/05-after-logout.png', fullPage: true });
  });
});

test.describe('New conversation modal', () => {
  test('opens modal with checkboxes excluding current country', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/');
    await loginViaUI(page);
    await page.click('#btn-new-conv');

    const modal = page.locator('#new-conv-modal');
    await expect(modal).toHaveClass(/open/);

    // Should have checkboxes for all countries except the logged-in one (england)
    const checkboxes = modal.locator('input[type="checkbox"]');
    await expect(checkboxes).toHaveCount(6);
    const values = await checkboxes.evaluateAll((cbs) =>
      (cbs as HTMLInputElement[]).map((c) => c.value),
    );
    expect(values).not.toContain('england');
    await page.screenshot({ path: 'test-results/06-new-conv-modal.png', fullPage: true });
  });

  test('shows validation error when no country is checked', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/');
    await loginViaUI(page);
    await page.click('#btn-new-conv');
    await page.click('#btn-modal-create');
    await expect(page.locator('#modal-error')).toContainText('Select 1 or 2 other countries');
    await page.screenshot({ path: 'test-results/07-modal-validation.png', fullPage: true });
  });

  test('cancel button closes the modal', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/');
    await loginViaUI(page);
    await page.click('#btn-new-conv');
    await expect(page.locator('#new-conv-modal')).toHaveClass(/open/);
    await page.click('#btn-modal-cancel');
    await expect(page.locator('#new-conv-modal')).not.toHaveClass(/open/);
  });

  test('clicking outside modal closes it', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/');
    await loginViaUI(page);
    await page.click('#btn-new-conv');
    // Click on the overlay (the modal-overlay element itself, outside the .modal box)
    await page.locator('#new-conv-modal').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('#new-conv-modal')).not.toHaveClass(/open/);
  });
});

test.describe('Conversation flow', () => {
  test('creates conversation and shows chat area', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/');
    await loginViaUI(page);

    // Open modal, select France, create
    await page.click('#btn-new-conv');
    await page.check('input[value="france"]');
    await page.click('#btn-modal-create');

    // Modal should close and chat should open
    await expect(page.locator('#new-conv-modal')).not.toHaveClass(/open/);
    await expect(page.locator('#messages')).toBeVisible();
    await expect(page.locator('#send-form')).toBeVisible();
    // Chat header should show conversation participants
    await expect(page.locator('#chat-header')).toContainText('England');
    await expect(page.locator('#chat-header')).toContainText('France');
    await page.screenshot({ path: 'test-results/08-chat-open.png', fullPage: true });
  });

  test('conversation appears in sidebar after creation', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/');
    await loginViaUI(page);

    await page.click('#btn-new-conv');
    await page.check('input[value="france"]');
    await page.click('#btn-modal-create');

    // Sidebar should list the new conversation (label = other country = "France")
    await expect(page.locator('#conv-list .conv-item')).toContainText('France');
    await page.screenshot({ path: 'test-results/09-conv-in-sidebar.png', fullPage: true });
  });
});

test.describe('Messaging', () => {
  test('sending a message displays it in the chat', async ({ page }) => {
    const messages: MockMessage[] = [];
    await setupApiMocks(page, { messages });
    await page.goto('/');
    await loginViaUI(page);

    // Create a conversation first
    await page.click('#btn-new-conv');
    await page.check('input[value="france"]');
    await page.click('#btn-modal-create');

    // Type and send a message
    const msgText = 'Hello France, let us form an alliance!';
    await page.fill('#msg-input', msgText);
    await page.click('#send-form button[type="submit"]');

    // The message should appear as a "mine" bubble
    const msgEl = page.locator('.msg.mine .msg-text');
    await expect(msgEl).toContainText(msgText);
    await page.screenshot({ path: 'test-results/10-message-sent.png', fullPage: true });
  });

  test('received message from another country shown with sender label', async ({ page }) => {
    const messages: MockMessage[] = [
      {
        message_id: 'recv-1',
        room_id: ROOM_ID,
        conversation_id: CONV_ID,
        sender_country: 'france',
        content: 'Bonjour England!',
        timestamp: 1_700_000_000_000,
      },
    ];
    const conversations: MockConversation[] = [
      { conversation_id: CONV_ID, participants: ['england', 'france'] },
    ];
    await setupApiMocks(page, { conversations, messages });

    await page.goto('/');
    await loginViaUI(page);

    // Click the existing conversation
    await page.click('.conv-item');

    // Should show the message with sender label "France"
    await expect(page.locator('.msg.theirs .msg-sender')).toContainText('France');
    await expect(page.locator('.msg.theirs .msg-text')).toContainText('Bonjour England!');
    await page.screenshot({ path: 'test-results/11-received-message.png', fullPage: true });
  });
});
