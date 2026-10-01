import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';
import { AuthenticatedTabNavigator } from '../src/navigation/AuthenticatedTabNavigator';
import { AuthProvider } from '../src/context/AuthContext';
import type { Session } from '@supabase/supabase-js';

const mockUser = {
  id: '33333333-3333-4333-8333-333333333333',
  phone: '+919876543210',
};

const mockSession = {
  access_token: 'valid-token',
  user: mockUser,
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

describe('AuthenticatedTabNavigator Architecture & Tab Isolation Suite', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  async function renderNavigator(props = {}) {
    const rendered = render(
      <AuthProvider>
        <AuthenticatedTabNavigator onboardedAt="2026-10-01T10:00:00Z" {...props} />
      </AuthProvider>
    );
    await act(async () => {});
    return rendered;
  }

  it('mounts with Discover as the default tab and correct accessibility state', async () => {
    const { getByTestId, queryByTestId } = await renderNavigator();

    // 1. Discover is default active tab
    expect(getByTestId('discover-shell-screen')).toBeTruthy();
    expect(queryByTestId('requests-shell-screen')).toBeNull();
    expect(queryByTestId('messages-shell-screen')).toBeNull();
    expect(queryByTestId('account-shell-screen')).toBeNull();

    // 2. Discover tab button has selected: true, others have selected: false
    const discoverTab = getByTestId('tab-button-discover');
    const requestsTab = getByTestId('tab-button-requests');
    const messagesTab = getByTestId('tab-button-messages');
    const accountTab = getByTestId('tab-button-account');

    expect(discoverTab.props.accessibilityRole).toBe('tab');
    expect(discoverTab.props.accessibilityState.selected).toBe(true);

    expect(requestsTab.props.accessibilityRole).toBe('tab');
    expect(requestsTab.props.accessibilityState.selected).toBe(false);

    expect(messagesTab.props.accessibilityRole).toBe('tab');
    expect(messagesTab.props.accessibilityState.selected).toBe(false);

    expect(accountTab.props.accessibilityRole).toBe('tab');
    expect(accountTab.props.accessibilityState.selected).toBe(false);
  });

  it('navigates from Discover -> Requests and renders ONLY RequestsShellScreen', async () => {
    const { getByTestId, queryByTestId } = await renderNavigator();

    fireEvent.press(getByTestId('tab-button-requests'));

    expect(getByTestId('requests-shell-screen')).toBeTruthy();
    expect(queryByTestId('discover-shell-screen')).toBeNull();
    expect(queryByTestId('messages-shell-screen')).toBeNull();
    expect(queryByTestId('account-shell-screen')).toBeNull();

    expect(getByTestId('tab-button-requests').props.accessibilityState.selected).toBe(true);
    expect(getByTestId('tab-button-discover').props.accessibilityState.selected).toBe(false);
  });

  it('navigates from Discover -> Messages and renders ONLY MessagesShellScreen', async () => {
    const { getByTestId, queryByTestId } = await renderNavigator();

    fireEvent.press(getByTestId('tab-button-messages'));

    expect(getByTestId('messages-shell-screen')).toBeTruthy();
    expect(queryByTestId('discover-shell-screen')).toBeNull();
    expect(queryByTestId('requests-shell-screen')).toBeNull();
    expect(queryByTestId('account-shell-screen')).toBeNull();

    expect(getByTestId('tab-button-messages').props.accessibilityState.selected).toBe(true);
    expect(getByTestId('tab-button-discover').props.accessibilityState.selected).toBe(false);
  });

  it('navigates from Discover -> Account and renders ONLY AccountShellScreen', async () => {
    const { getByTestId, queryByTestId } = await renderNavigator();

    fireEvent.press(getByTestId('tab-button-account'));

    expect(getByTestId('account-shell-screen')).toBeTruthy();
    expect(queryByTestId('discover-shell-screen')).toBeNull();
    expect(queryByTestId('requests-shell-screen')).toBeNull();
    expect(queryByTestId('messages-shell-screen')).toBeNull();

    expect(getByTestId('tab-button-account').props.accessibilityState.selected).toBe(true);
    expect(getByTestId('tab-button-discover').props.accessibilityState.selected).toBe(false);
  });

  it('renders neutral area selection placeholder in Discover without pretending location is selected', async () => {
    const { getByTestId, getByText } = await renderNavigator();

    expect(getByTestId('discover-location-placeholder')).toBeTruthy();
    expect(getByText('Select an area')).toBeTruthy();
    expect(getByText('Choose your area when discovery is available.')).toBeTruthy();
    expect(getByText('Search services or providers...')).toBeTruthy();
  });

  it('allows toggling between Active and Past filter shell in Requests', async () => {
    const { getByTestId } = await renderNavigator();

    fireEvent.press(getByTestId('tab-button-requests'));

    const activeFilter = getByTestId('requests-filter-active');
    const pastFilter = getByTestId('requests-filter-past');

    expect(activeFilter.props.accessibilityState.selected).toBe(true);
    expect(pastFilter.props.accessibilityState.selected).toBe(false);

    fireEvent.press(pastFilter);

    expect(activeFilter.props.accessibilityState.selected).toBe(false);
    expect(pastFilter.props.accessibilityState.selected).toBe(true);
  });

  it('renders clear explanation in Messages that conversations unlock via service requests', async () => {
    const { getByTestId, getByText } = await renderNavigator();

    fireEvent.press(getByTestId('tab-button-messages'));

    expect(getByTestId('messages-empty-state')).toBeTruthy();
    expect(
      getByText('Conversations become available after a service provider accepts your service request.')
    ).toBeTruthy();
  });

  it('isolates user sessions: remounting navigator with a new key resets to Discover tab', async () => {
    const { getByTestId, queryByTestId, rerender } = render(
      <AuthProvider>
        <AuthenticatedTabNavigator key="user-1" />
      </AuthProvider>
    );
    await act(async () => {});

    // Switch User 1 to Account tab
    fireEvent.press(getByTestId('tab-button-account'));
    expect(getByTestId('account-shell-screen')).toBeTruthy();

    // User switches to User 2 (new key)
    rerender(
      <AuthProvider>
        <AuthenticatedTabNavigator key="user-2" />
      </AuthProvider>
    );
    await act(async () => {});

    // User 2 instance must strictly mount at default Discover tab, not User 1's Account tab
    expect(getByTestId('discover-shell-screen')).toBeTruthy();
    expect(queryByTestId('account-shell-screen')).toBeNull();
  });
});
