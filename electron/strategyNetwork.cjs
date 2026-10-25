// The game's loopback UI must remain reachable independently of a remote proxy.
// Keep OpenAI on its own system-proxy session; never borrow browser cookies.
exports.createStrategyNetwork = async (session) => {
  const remote = session.fromPartition('strategy-openai-network');
  await remote.setProxy({ mode: 'system' });
  const local = session.defaultSession;
  await local.setProxy({ mode: 'direct' });
  return { local, remote, fetch: (url, options) => remote.fetch(url, { ...options, credentials: 'omit' }) };
};
