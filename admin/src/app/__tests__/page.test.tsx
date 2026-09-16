import { render, screen } from '@testing-library/react';
import Page from '../page';

describe('Admin Page', () => {
  it('renders root page component with heading and Next.js logo', () => {
    render(<Page />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/to get started, edit the page\.tsx file/i);
    expect(screen.getByAltText(/next\.js logo/i)).toBeInTheDocument();
  });
});
