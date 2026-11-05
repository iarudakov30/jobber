import { TestBed } from '@angular/core/testing';

import { Session } from './session';

describe('Session', () => {
  const user = { id: '1', email: 'test@example.com' };

  beforeEach(() => localStorage.clear());

  it('starts signed out', () => {
    const session = TestBed.inject(Session);
    expect(session.user()).toBeNull();
    expect(session.isAuthenticated()).toBe(false);
  });

  it('restores a stored user', () => {
    localStorage.setItem('jobber.user', JSON.stringify(user));
    expect(TestBed.inject(Session).user()).toEqual(user);
  });

  it('persists and clears the user', () => {
    const session = TestBed.inject(Session);

    session.set(user);
    expect(session.isAuthenticated()).toBe(true);
    expect(JSON.parse(localStorage.getItem('jobber.user') ?? 'null')).toEqual(
      user,
    );

    session.clear();
    expect(session.isAuthenticated()).toBe(false);
    expect(localStorage.getItem('jobber.user')).toBeNull();
  });
});
