import React from 'react';
import { render } from '@testing-library/react-native';
import App from '../App';

describe('<App />', () => {
  it('renders without throwing', async () => {
    const rendered = await render(<App />);
    expect(rendered.toJSON()).toBeTruthy();
  });
});

