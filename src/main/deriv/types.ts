// Minimal typings for the Deriv WS API subset we use.
// Full spec: https://developers.deriv.com/docs/websockets/

export type DerivRequest = {
  req_id?: number;
  passthrough?: Record<string, unknown>;
} & (
  | { ping: 1 }
  | { authorize: string }
  | { ticks: string; subscribe?: 1 }
  | { forget: string }
  | { forget_all: "ticks" | "candles" | "proposal" | "proposal_open_contract" }
  | {
      ticks_history: string;
      adjust_start_time?: 1;
      count?: number;
      end: string | "latest";
      start?: number;
      style: "candles" | "ticks";
      granularity?: number;
      subscribe?: 1;
    }
  | {
      proposal: 1;
      amount: number;
      basis: "stake" | "payout";
      contract_type: "CALL" | "PUT" | "CALLE" | "PUTE";
      currency: string;
      duration: number;
      duration_unit: "t" | "s" | "m" | "h" | "d";
      symbol: string;
      subscribe?: 1;
    }
  | {
      proposal: 1;
      amount: number;
      basis: "stake";
      contract_type: "MULTUP" | "MULTDOWN";
      currency: string;
      symbol: string;
      multiplier: number;
      limit_order?: { take_profit?: number; stop_loss?: number };
      subscribe?: 1;
    }
  | { buy: string; price: number }
  | { sell: string; price: number }
  | { balance: 1; subscribe?: 1 }
  | { proposal_open_contract: 1; contract_id?: number; subscribe?: 1 }
  | { active_symbols: "brief" | "full"; product_type?: "basic" }
);

export type DerivResponse = {
  echo_req?: Record<string, unknown>;
  msg_type: string;
  req_id?: number;
  error?: { code: string; message: string };
  subscription?: { id: string };
} & Record<string, unknown>;

export type OhlcCandle = {
  epoch: number;
  open_time?: number;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
};

export type AuthorizeInfo = {
  account_list?: Array<{ loginid: string; currency: string; is_virtual: 0 | 1 }>;
  balance?: number;
  currency?: string;
  email?: string;
  loginid?: string;
  is_virtual?: 0 | 1;
  country?: string;
  fullname?: string;
};

export type ProposalInfo = {
  id: string;           // proposal id used for buy
  ask_price: number;
  payout: number;
  spot?: number;
  spot_time?: number;
  display_value?: string;
  longcode?: string;
};

export type BuyInfo = {
  contract_id: number;
  balance_after: number;
  buy_price: number;
  start_time: number;
  transaction_id: number;
  longcode?: string;
  payout?: number;
};

export type ActiveSymbolInfo = {
  symbol: string;
  display_name: string;
  market: string;
  market_display_name: string;
  submarket: string;
  submarket_display_name: string;
  pip: number;
  /** pip_size may not always be present; fallback to `pip`. */
  pip_size?: number;
  /** Number of decimal places Deriv displays for this symbol. */
  display_decimals?: number;
  exchange_is_open: 0 | 1;
  is_trading_suspended: 0 | 1;
  allow_forward_starting?: 0 | 1;
};

export type OpenContractInfo = {
  contract_id: number;
  status?: "open" | "sold" | "won" | "lost";
  is_sold?: 0 | 1;
  is_expired?: 0 | 1;
  profit?: number;
  profit_percentage?: number;
  entry_spot?: number;
  exit_tick?: number;
  sell_price?: number;
  sell_time?: number;
  buy_price?: number;
  currency?: string;
  underlying?: string;
  contract_type?: string;
};
