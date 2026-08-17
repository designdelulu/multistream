import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindScreenWakeLock } from './wakeLock';

function sentinel() {
  return {
    release: vi.fn().mockResolvedValue(undefined),
    addEventListener: vi.fn(),
  };
}

describe('bindScreenWakeLock', () => {
  afterEach(() => vi.restoreAllMocks());

  it('acquires while eligible and releases when the lineup becomes empty', async () => {
    const lock = sentinel();
    const request = vi.fn().mockResolvedValue(lock);
    let hold = true;
    const binding = bindScreenWakeLock(() => hold, { wakeLock: { request } });

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('screen'));
    hold = false;
    binding.sync();
    expect(lock.release).toHaveBeenCalledOnce();
    binding.destroy();
  });

  it('releases while hidden and reacquires after visibility returns', async () => {
    let visibility: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const first = sentinel();
    const second = sentinel();
    const request = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const binding = bindScreenWakeLock(() => true, { wakeLock: { request } });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(first.release).toHaveBeenCalledOnce();

    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    binding.destroy();
  });
});
