import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';
import { AccountShellScreen } from '../src/screens/authenticated/AccountShellScreen';
import { AuthProvider } from '../src/context/AuthContext';
import { supabase } from '../src/lib/supabase';
import type { Session } from '@supabase/supabase-js';

const mockRawUserId = '44444444-4444-4444-8444-444444444444';
const mockRawPhone = '+919876543210';

const mockSession = {
  access_token: 'valid-session-jwt',
  user: {
    id: mockRawUserId,
    phone: mockRawPhone,
  },
} as unknown as Session;

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve({ data: { session: mockSession }, error: null })),
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
      signOut: jest.fn(() => Promise.resolve({ error: null })),
    },
  },
}));

describe('AccountShellScreen Privacy & Factual Presentation Suite', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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

  it('renders factual "Onboarded Member" and "Account Active" without verification claims', async () => {
    const { getByTestId, queryByText } = await renderScreen();

    // 1. Must display factual Onboarded Member
    const membershipTitle = getByTestId('account-membership-title');
    expect(membershipTitle.props.children).toBe('Onboarded Member');

    // 2. Must display factual Account Active badge
    expect(getByTestId('account-status-badge')).toBeTruthy();

    // 3. MANDATORY NEGATIVE CHECK: Must NOT contain "Verified Member" or "Verified Customer"
    expect(queryByText(/verified member/i)).toBeNull();
    expect(queryByText(/verified customer/i)).toBeNull();
  });

  it('masks user phone number and does NOT display raw phone in plain text', async () => {
    const { getByTestId, queryByText } = await renderScreen();

    const maskedPhoneText = getByTestId('account-masked-phone').props.children;

    // Masked phone format (e.g., "+91 ••••• •3210")
    expect(maskedPhoneText).toContain('+91');
    expect(maskedPhoneText).toContain('3210');
    expect(maskedPhoneText).toContain('•');

    // Raw 10-digit subscriber phone must not be visible unmasked
    expect(queryByText('9876543210')).toBeNull();
    expect(queryByText('+919876543210')).toBeNull();
  });

  it('does NOT display raw database UUID in the UI', async () => {
    const { queryByText } = await renderScreen();

    // Internal database UUID must remain completely hidden from UI
    expect(queryByText(mockRawUserId)).toBeNull();
  });

  it('displays formatted onboarding date from props', async () => {
    const { getByTestId } = await renderScreen();

    expect(getByTestId('account-onboarded-date').props.children).toBe('2026-10-01');
  });

  it('allows opening legal modal showing Terms and Privacy in PENDING_REVIEW state', async () => {
    const { getByTestId, getByText, queryByTestId } = await renderScreen();

    // Click View Terms
    fireEvent.press(getByTestId('account-view-tos-button'));

    expect(getByTestId('legal-modal-title').props.children).toBe('Terms of Service');
    expect(getByTestId('legal-modal-status-badge')).toBeTruthy();
    expect(getByText('Notice to Users')).toBeTruthy();

    // Close modal
    fireEvent.press(getByTestId('legal-modal-close-button'));

    await waitFor(() => {
      expect(queryByTestId('legal-modal-title')).toBeNull();
    });
  });

  it('invokes signOut on AuthContext when Sign Out is pressed', async () => {
    const { getByTestId } = await renderScreen();

    const signOutBtn = getByTestId('account-signout-button');
    await act(async () => {
      fireEvent.press(signOutBtn);
    });

    expect(supabase.auth.signOut).toHaveBeenCalledTimes(1);
  });
});
