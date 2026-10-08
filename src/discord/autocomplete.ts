export interface AutocompleteOption {
  name: string;
  value?: string | number | boolean;
  focused?: boolean;
  options?: AutocompleteOption[];
}
export interface AutocompleteRequest {
  data?: { name?: string; options?: AutocompleteOption[] };
}
const quickPicks = [
  { symbol: 'SPY', name: 'SPY · S&P 500 ETF', market: 'equity' },
  { symbol: 'QQQ', name: 'QQQ · Nasdaq-100 ETF', market: 'equity' },
  { symbol: 'AAPL', name: 'AAPL · Apple', market: 'equity' },
  { symbol: 'MSFT', name: 'MSFT · Microsoft', market: 'equity' },
  { symbol: 'NVDA', name: 'NVDA · NVIDIA', market: 'equity' },
  { symbol: 'AMD', name: 'AMD · AMD', market: 'equity' },
  { symbol: 'TSLA', name: 'TSLA · Tesla', market: 'equity' },
  { symbol: 'AMZN', name: 'AMZN · Amazon', market: 'equity' },
  { symbol: 'META', name: 'META · Meta', market: 'equity' },
  { symbol: 'IWM', name: 'IWM · Russell 2000 ETF', market: 'equity' },
  { symbol: 'BTC-USD', name: 'BTC-USD · Bitcoin · Coinbase', market: 'crypto' },
  { symbol: 'ETH-USD', name: 'ETH-USD · Ethereum · Coinbase', market: 'crypto' },
  { symbol: 'SOL-USD', name: 'SOL-USD · Solana · Coinbase', market: 'crypto' },
  { symbol: 'DOGE-USD', name: 'DOGE-USD · Dogecoin · Coinbase', market: 'crypto' },
  { symbol: 'LINK-USD', name: 'LINK-USD · Chainlink · Coinbase', market: 'crypto' },
  { symbol: 'AVAX-USD', name: 'AVAX-USD · Avalanche · Coinbase', market: 'crypto' },
];

/** Local suggestions return immediately; normal add validation still checks the provider. */
export function watchSuggestions(request: AutocompleteRequest): { name: string; value: string }[] {
  if (request.data?.name !== 'watch' || !Array.isArray(request.data.options)) return [];
  const action = request.data.options.find((o) => o.name === 'add');
  if (!Array.isArray(action?.options)) return [];
  const focused = action.options.find((o) => o.focused);
  if (focused?.name !== 'symbol' || typeof focused.value !== 'string') return [];
  const query = focused.value.trim().toUpperCase();
  const market = action.options.find((o) => o.name === 'market')?.value;
  if (market !== undefined && market !== 'crypto' && market !== 'equity') return [];
  const choices = quickPicks
    .filter(
      (p) =>
        (!market || p.market === market) &&
        (!query || p.symbol.startsWith(query) || p.name.toUpperCase().includes(query)),
    )
    .map((p) => ({ name: p.name, value: p.symbol }));
  if (query && /^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(query) && choices.length === 0)
    choices.push({ name: `${query} · Use custom symbol`, value: query });
  return choices.slice(0, 25);
}

export function cachedSuggestions(
  request: AutocompleteRequest,
  symbols: string[],
  ideas: { id: string; symbol: string; state: string }[],
): { name: string; value: string }[] {
  const findFocused = (rows: AutocompleteOption[]): AutocompleteOption | undefined => {
    for (const row of rows) {
      if (row.focused) return row;
      const found = findFocused(row.options ?? []);
      if (found) return found;
    }
    return undefined;
  };
  const focused = findFocused(request.data?.options ?? []);
  const query = String(focused?.value ?? '')
    .trim()
    .toUpperCase();
  if (request.data?.name === 'idea' && focused?.name === 'id')
    return ideas
      .filter((i) => i.id.toUpperCase().startsWith(query) || i.symbol.startsWith(query))
      .slice(0, 25)
      .map((i) => ({ name: `${i.symbol} · ${i.state} · ${i.id}`.slice(0, 100), value: i.id }));
  if (
    !['chart', 'explain', 'context', 'follow'].includes(request.data?.name ?? '') ||
    focused?.name !== 'symbol'
  )
    return [];
  return [...new Set(symbols)]
    .filter((s) => s.includes(query))
    .sort()
    .slice(0, 25)
    .map((s) => ({ name: s, value: s }));
}
