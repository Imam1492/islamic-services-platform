import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { GeneralUserOnboardingScreen } from '../src/screens/GeneralUserOnboardingScreen';
import { LegalDocumentService } from '../src/services/legalDocumentService';
import { AuthProvider } from '../src/context/AuthContext';
import { CONTROLLED_TOS_VERSION, CONTROLLED_PRIVACY_VERSION } from '../src/constants/legal';

// Mock Supabase in AuthContext
jest.mock('../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
      signOut: jest.fn(() => Promise.resolve({ error: null })),
    },
  },
}));

describe('GeneralUserOnboardingScreen Component & Privacy Guardrails Suite', () => {
  const mockOnSubmit = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  async function renderScreen(props = {}) {
    const rendered = render(
      <AuthProvider>
        <GeneralUserOnboardingScreen
          onSubmit={mockOnSubmit}
          isSubmitting={false}
          {...props}
        />
      </AuthProvider>
    );
    await act(async () => {});
    return rendered;
  }

  it('renders initial empty form with Submit button disabled and Pending Review banner', async () => {
    const { getByTestId, getByText } = await renderScreen();

    expect(getByText('Complete Your Profile')).toBeTruthy();
    expect(getByTestId('compliance-pending-banner')).toBeTruthy();
    expect(getByTestId('onboarding-fullname-input').props.value).toBe('');
    expect(getByTestId('onboarding-submit-button').props.accessibilityState.disabled).toBe(true);
  });

  it('strictly disables Submit button when legal documents are in PENDING_REVIEW status', async () => {
    // Both documents are PENDING_REVIEW in this repo
    const { getByTestId } = await renderScreen();

    // Fill valid name
    fireEvent.changeText(getByTestId('onboarding-fullname-input'), 'Amina Al-Mansoor');

    // Check adult checkbox
    fireEvent.press(getByTestId('checkbox-adult-ack'));

    // Try checking Terms and Privacy (disabled in PENDING_REVIEW)
    fireEvent.press(getByTestId('checkbox-tos'));
    fireEvent.press(getByTestId('checkbox-privacy'));

    // Submit MUST remain disabled
    expect(getByTestId('onboarding-submit-button').props.accessibilityState.disabled).toBe(true);

    // Pressing submit does not call onSubmit
    fireEvent.press(getByTestId('onboarding-submit-button'));
    expect(mockOnSubmit).not.toHaveBeenCalled();
  });

  it('allows viewing legal document modal with Pending Review status badge and notice', async () => {
    const { getByTestId, getByText, queryByTestId } = await renderScreen();

    // Click View Terms button
    fireEvent.press(getByTestId('view-tos-button'));

    expect(getByTestId('legal-modal-title').props.children).toBe('Terms of Service');
    expect(getByTestId('legal-modal-version').props.children).toContain(CONTROLLED_TOS_VERSION);
    expect(getByTestId('legal-modal-status-badge')).toBeTruthy();
    expect(getByText('Notice to Users')).toBeTruthy();

    // Close modal
    fireEvent.press(getByTestId('legal-modal-close-button'));

    await waitFor(() => {
      expect(queryByTestId('legal-modal-title')).toBeNull();
    });
  });

  it('enables Submit button ONLY when all criteria are met if documents were approved', async () => {
    // Mock LegalDocumentService.getDocuments to return approved status
    const getDocsSpy = jest.spyOn(LegalDocumentService, 'getDocuments').mockReturnValue({
      termsOfService: {
        id: 'terms_of_service',
        title: 'Terms of Service',
        version: CONTROLLED_TOS_VERSION,
        status: 'APPROVED',
        effectiveDate: '2026-09-01',
        content: 'Approved Terms',
      },
      privacyPolicy: {
        id: 'privacy_policy',
        title: 'Privacy Policy',
        version: CONTROLLED_PRIVACY_VERSION,
        status: 'APPROVED',
        effectiveDate: '2026-09-01',
        content: 'Approved Privacy',
      },
      allApproved: true,
    });

    const { getByTestId } = await renderScreen();

    // 1. Initially disabled
    expect(getByTestId('onboarding-submit-button').props.accessibilityState.disabled).toBe(true);

    // 2. Add valid name (still disabled because checkboxes unchecked)
    fireEvent.changeText(getByTestId('onboarding-fullname-input'), 'Amina Al-Mansoor');
    expect(getByTestId('onboarding-submit-button').props.accessibilityState.disabled).toBe(true);

    // 3. Check adult ack (still disabled)
    fireEvent.press(getByTestId('checkbox-adult-ack'));
    expect(getByTestId('onboarding-submit-button').props.accessibilityState.disabled).toBe(true);

    // 4. Check ToS (still disabled)
    fireEvent.press(getByTestId('checkbox-tos'));
    expect(getByTestId('onboarding-submit-button').props.accessibilityState.disabled).toBe(true);

    // 5. Check Privacy (now all criteria satisfied -> enabled!)
    fireEvent.press(getByTestId('checkbox-privacy'));
    expect(getByTestId('onboarding-submit-button').props.accessibilityState.disabled).toBe(false);

    // 6. Submit trims name and calls onSubmit
    fireEvent.press(getByTestId('onboarding-submit-button'));
    expect(mockOnSubmit).toHaveBeenCalledWith('Amina Al-Mansoor');

    getDocsSpy.mockRestore();
  });

  it('renders inline error banner when externalError is passed', async () => {
    const { getByTestId, getByText } = await renderScreen({
      externalError: 'A database conflict occurred. Please retry.',
    });

    expect(getByTestId('onboarding-error-banner')).toBeTruthy();
    expect(getByText('A database conflict occurred. Please retry.')).toBeTruthy();
  });
});
