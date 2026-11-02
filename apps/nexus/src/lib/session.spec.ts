const user = { id: '1', email: 'test@example.com' };

describe('session', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  async function loadSession() {
    return (await import('./session')).session;
  }

  it('starts empty without a stored user', async () => {
    expect((await loadSession()).get()).toBeNull();
  });

  it('remembers the user across reloads', async () => {
    (await loadSession()).set(user);

    vi.resetModules();
    expect((await loadSession()).get()).toEqual(user);
  });

  it('forgets the user on clear', async () => {
    const session = await loadSession();
    session.set(user);
    session.clear();

    expect(session.get()).toBeNull();
    expect(localStorage.getItem('nexus.user')).toBeNull();
  });

  it('notifies subscribers until they unsubscribe', async () => {
    const session = await loadSession();
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);

    session.set(user);
    unsubscribe();
    session.clear();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('ignores a corrupted stored value', async () => {
    localStorage.setItem('nexus.user', '{not json');

    expect((await loadSession()).get()).toBeNull();
  });
});
