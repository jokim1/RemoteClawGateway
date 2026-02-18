import { evaluateToolAvailability, isBrowserIntent, resolveProxyGatewayToolsEnabled } from '../talk-policy';

describe('talk policy availability reasons', () => {
  test('marks uninstalled tools as blocked_not_installed', () => {
    const states = evaluateToolAvailability(
      [{ name: 'google_docs_add_tab', description: 'tab tool', builtin: true }],
      {
        executionMode: 'openclaw',
        filesystemAccess: 'full_host_access',
        networkAccess: 'full_outbound',
        toolsAllow: [],
        toolsDeny: [],
        toolMode: 'auto',
      },
      {
        isInstalled: () => false,
      },
    );
    expect(states[0]?.enabled).toBe(false);
    expect(states[0]?.reasonCode).toBe('blocked_not_installed');
  });

  test('marks tools blocked_execution_mode in openclaw mode', () => {
    const states = evaluateToolAvailability(
      [{ name: 'google_docs_create', description: 'docs', builtin: true }],
      {
        executionMode: 'openclaw',
        filesystemAccess: 'full_host_access',
        networkAccess: 'full_outbound',
        toolsAllow: [],
        toolsDeny: [],
        toolMode: 'off',
      },
      {
        isInstalled: () => true,
      },
    );
    expect(states[0]?.enabled).toBe(false);
    expect(states[0]?.reasonCode).toBe('blocked_execution_mode');
  });

  test('allows native google tools in openclaw mode when native bridge is enabled', () => {
    const states = evaluateToolAvailability(
      [{ name: 'google_docs_create', description: 'docs', builtin: true }],
      {
        executionMode: 'openclaw',
        filesystemAccess: 'full_host_access',
        networkAccess: 'full_outbound',
        toolsAllow: [],
        toolsDeny: [],
        toolMode: 'auto',
      },
      {
        isInstalled: () => true,
        isOpenClawNativeTool: () => true,
        openClawNativeToolsEnabled: true,
      },
    );
    expect(states[0]?.enabled).toBe(true);
    expect(states[0]?.reasonCode).toBeUndefined();
  });

  test('marks tools blocked_tool_mode when approval is off in full_control mode', () => {
    const states = evaluateToolAvailability(
      [{ name: 'google_docs_create', description: 'docs', builtin: true }],
      {
        executionMode: 'full_control',
        filesystemAccess: 'full_host_access',
        networkAccess: 'full_outbound',
        toolsAllow: [],
        toolsDeny: [],
        toolMode: 'off',
      },
      {
        isInstalled: () => true,
      },
    );
    expect(states[0]?.enabled).toBe(false);
    expect(states[0]?.reasonCode).toBe('blocked_tool_mode');
  });

  test('blocks managed tools in full_control mode when proxy passthrough is disabled', () => {
    const states = evaluateToolAvailability(
      [{ name: 'google_docs_list_tabs', description: 'docs tabs', builtin: true }],
      {
        executionMode: 'full_control',
        filesystemAccess: 'full_host_access',
        networkAccess: 'full_outbound',
        toolsAllow: [],
        toolsDeny: [],
        toolMode: 'auto',
      },
      {
        isInstalled: () => true,
        isManagedTool: () => true,
      },
    );
    expect(states[0]?.enabled).toBe(false);
    expect(states[0]?.reasonCode).toBe('blocked_execution_mode');
  });

  test('allows managed tools in full_control mode when proxy passthrough is enabled', () => {
    const states = evaluateToolAvailability(
      [{ name: 'google_docs_list_tabs', description: 'docs tabs', builtin: true }],
      {
        executionMode: 'full_control',
        filesystemAccess: 'full_host_access',
        networkAccess: 'full_outbound',
        toolsAllow: [],
        toolsDeny: [],
        toolMode: 'auto',
      },
      {
        isInstalled: () => true,
        isManagedTool: () => true,
        proxyGatewayToolsEnabled: true,
      },
    );
    expect(states[0]?.enabled).toBe(true);
    expect(states[0]?.reasonCode).toBeUndefined();
  });

  test('marks tools blocked_auth when required oauth is not ready', () => {
    const states = evaluateToolAvailability(
      [{ name: 'google_docs_create', description: 'docs', builtin: true }],
      {
        executionMode: 'full_control',
        filesystemAccess: 'full_host_access',
        networkAccess: 'full_outbound',
        toolsAllow: [],
        toolsDeny: [],
        toolMode: 'auto',
      },
      {
        isInstalled: () => true,
        isAuthReady: () => ({ ready: false, reason: 'Blocked by Google OAuth: profile "default" is not ready.' }),
      },
    );
    expect(states[0]?.enabled).toBe(false);
    expect(states[0]?.reasonCode).toBe('blocked_auth');
  });
});

describe('browser intent detection', () => {
  test('matches direct browser control asks', () => {
    expect(isBrowserIntent('please take over my browser now')).toBe(true);
  });

  test('ignores negated browser mentions', () => {
    expect(isBrowserIntent('create a google doc directly rather than using browser')).toBe(false);
    expect(isBrowserIntent("don't use browser, use google docs api")).toBe(false);
    expect(isBrowserIntent('without browser, create the doc')).toBe(false);
  });
});

describe('proxy gateway tools flag', () => {
  test('defaults to enabled when unset', () => {
    expect(resolveProxyGatewayToolsEnabled(undefined)).toBe(true);
  });

  test('disables when explicitly false', () => {
    expect(resolveProxyGatewayToolsEnabled(false)).toBe(false);
    expect(resolveProxyGatewayToolsEnabled('false')).toBe(false);
  });
});
