import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';
import { AccountShellScreen } from '../src/screens/authenticated/AccountShellScreen';
import { AuthProvider } from '../src/context/AuthContext';
import { supabase } from '../src/lib/supabase';
import type { Session } from '@supabase/supabase-js';

const mockRawUserId = '44444444-4444-4444-8444-444444444444';
const mockUserEmail = 'verified_user@example.com';
const mockRawPhone = '+919876543210';

let mockCurrentSession: Session | null = {
  access_token: 'valid-session-jwt',
  user: {
    id: mockRawUserId,
    email: mockUserEmail,
    phone: mockRawPhone,
  },
} as unknown as Session;

jest.mock('../src/lib/secureStorage', () => ({
  LargeSecureStoreAdapter: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve({ data: { session: mockCurrentSession }, error: null })),
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
      signOut: jest.fn(() => Promise.resolve({ error: null })),
    },
  },
}));

describe('AccountShellScreen Privacy & Factual Presentation Suite — Google OAuth V1', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCurrentSession = {
      access_token: 'valid-session-jwt',
      user: {
        id: mockRawUserId,
        email: mockUserEmail,
        phone: mockRawPhone,
      },
    } as unknown as Session;
  });

  async function renderScreen(props = {}) {
    const rendered = render(
      <AuthProvider>
        <AccountShellScreen onboardedAt="2026-10-01T12:00:00.000Z" {...props} />
      </AuthProvider>
    );
    await act(async () => {});
    return rendered;
  }

  it('displays user email as the primary authentication/contact identifier', async () => {
    const { getByTestId, queryByText } = await renderScreen();

    const emailElement = getByTestId('account-email');
    expect(emailElement.props.children).toBe(mockUserEmail);
    expect(queryByText(mockUserEmail)).toBeTruthy();
  });

  it('renders factual "Onboarded Member" and "Account Active" without verification claims', async () => {
    const { getByTestId, queryByText } = await renderScreen();

    const membershipTitle = getByTestId('account-membership-title');
    expect(membershipTitle.props.children).toBe('Onboarded Member');

    expect(getByTestId('account-status-badge')).toBeTruthy();

    expect(queryByText(/verified member/i)).toBeNull();
    expect(queryByText(/verified customer/i)).toBeNull();
  });

  it('masks user phone number when present and does NOT display raw phone in plain text', async () => {
    const { getByTestId, queryByText } = await renderScreen();

    const maskedPhoneText = getByTestId('account-masked-phone').props.children;

    expect(maskedPhoneText).toContain('+91');
    expect(maskedPhoneText).toContain('3210');
    expect(maskedPhoneText).toContain('•');

    expect(queryByText('9876543210')).toBeNull();
    expect(queryByText('+919876543210')).toBeNull();
  });

  it('displays "Not provided" when user has no phone number (typical Google OAuth registration)', async () => {
    mockCurrentSession = {
      access_token: 'valid-session-jwt',
      user: {
        id: mockRawUserId,
        email: 'google_user@example.com',
        phone: undefined,
      },
    } as unknown as Session;

    const { getByTestId } = await renderScreen();

    const maskedPhoneText = getByTestId('account-masked-phone').props.children;
    expect(maskedPhoneText).toBe('Not provided');
  });

  it('shows a failure when sign-out cannot be confirmed', async () => {
    (supabase.auth.signOut as jest.Mock).mockResolvedValueOnce({
      error: { name: 'AuthUnknownError', status: 500 },
    });
    const { getByTestId } = await renderScreen();

    fireEvent.press(getByTestId('account-signout-button'));
    await waitFor(() => expect(getByTestId('account-signout-error')).toBeTruthy());
  });

  it('does NOT display raw database UUID in the UI', async () => {
    const { queryByText } = await renderScreen();

    expect(queryByText(mockRawUserId)).toBeNull();
  });

  it('displays formatted onboarding date from props', async () => {
    const { getByTestId } = await renderScreen();

    expect(getByTestId('account-onboarded-date').props.children).toBe('2026-10-01');
  });

  it('allows opening legal modal showing Terms and Privacy in PENDING_REVIEW state', async () => {
    const { getByTestId, getByText } = await renderScreen();

    fireEvent.press(getByTestId('account-view-tos-button'));

    expect(getByTestId('legal-modal-title').props.children).toBe('Terms of Service');
    expect(getByTestId('legal-modal-status-badge')).toBeTruthy();
    expect(getByText('Notice to Users')).toBeTruthy();

    fireEvent.press(getByTestId('legal-modal-close-button'));
  });

  it('handles sign out cleanly', async () => {
    const { getByTestId } = await renderScreen();

    const signOutBtn = getByTestId('account-signout-button');
    fireEvent.press(signOutBtn);

    await waitFor(() => {
      expect(supabase.auth.signOut).toHaveBeenCalled();
    });
  });
});
