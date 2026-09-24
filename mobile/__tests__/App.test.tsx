import React from 'react';
import { render, act } from '@testing-library/react-native';
import App from '../App';

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn().mockResolvedValue({
        data: { session: null },
        error: null,
      }),
      onAuthStateChange: jest.fn().mockReturnValue({
        data: {
          subscription: {
            unsubscribe: jest.fn(),
          },
        },
      }),
      signInWithOtp: jest.fn().mockResolvedValue({ error: null }),
      verifyOtp: jest.fn().mockResolvedValue({ data: { session: null, user: null }, error: null }),
      signOut: jest.fn().mockResolvedValue({ error: null }),
    },
  },
}));

describe('<App />', () => {
  it('renders without throwing', async () => {
    const rendered = render(<App />);
    await act(async () => {});
    expect(rendered.toJSON()).toBeTruthy();
  });
});


