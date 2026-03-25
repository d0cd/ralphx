import { describe, it, expect, vi, beforeEach } from 'vitest';
import { log, setLogLevel, setVerbose } from '../src/core/logger.js';

describe('Logger', () => {
  beforeEach(() => {
    setLogLevel('info');
  });

  it('info logs to console.log', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log.info('test message');
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toContain('test message');
    expect(spy.mock.calls[0][0]).toContain('[INFO]');
    spy.mockRestore();
  });

  it('debug is hidden at info level', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    log.debug('hidden');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('debug is visible when verbose', () => {
    setLogLevel('debug');
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    log.debug('visible');
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('warn always shows at info level', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    log.warn('warning');
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toContain('[WARN]');
    spy.mockRestore();
  });

  it('error always shows', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    log.error('failure');
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toContain('[ERROR]');
    spy.mockRestore();
  });
});
