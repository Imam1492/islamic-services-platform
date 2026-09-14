import '@testing-library/jest-dom';
import { render } from '@testing-library/react';
import Page from '../page';

describe('Admin Page', () => {
  it('renders root page component without throwing', () => {
    render(<Page />);
    expect(document.body).toBeDefined();
  });
});
