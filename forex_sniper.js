import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import express from 'express';
import cors from 'cors';
import basicAuth from 'express-basic-auth';
import TelegramBot from 'node-telegram-bot-api';

dotenv.config({ path: '.env.trading' });

const BRIDGE_URL   = 'http://127.0.0.1:5003';
const PORT         = process.env.FOREX_PORT || 5002;
const DASHBOARD_PWD = process.env.DASHBOARD_PASSWORD || '1234';
const LOG_FILE     = 'forex_logs.json';
const STATE_FILE   = 'forex_state.json';
const TG_TOKEN     = process.env.TELEGRAM_TOKEN;
const TG_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const bot          = TG_TOKEN ? new TelegramBot(TG_TOKEN, { polling: false }) : null;

const SYMBOLS = ['XAUUSD', 'EURUSD', 'GBPUSD'];

// Volume por símbolo (lote mínimo seguro)
const SYMBOL_VOLUME = { 'XAUUSD': 0.01, 'EURUSD': 0.05, 'GBPUSD': 0.05 };
// SL e TP em pontos por símbolo
const SYMBOL_SL_TP = {
    'XAUUSD': { sl: 200, tp: 350 }, // ~$2.00 SL / ~$3.50 TP no XAUUSD
    'EURUSD': { sl: 200, tp: 300 }, // pips
    'GBPUSD': { sl: 200, tp: 300 },
};

// Cooldown entre trades (ms)
const COOLDOWN_MS = 20000;

let state = {
    balanceUSD:     500.0,
    dailyProfitUSD: 0,
    lastProfitDate: '',
    activeSymbol:   'XAUUSD',
    inPosition:     false,
    positionSide:   null,
    entryPrice:     0,
    paused:         false,
    lastTradeTime:  0,
    scannerData:    {}
};

if (fs.existsSync(STATE_FILE)) {
    try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE)) }; } catch (e) {}
}

// Reset PnL diário
const today = new Date().toDateString();
if (state.lastProfitDate !== today) {
    state.dailyProfitUSD = 0;
    state.lastProfitDate = today;
}

function saveState() { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }

function sendTelegram(msg) {
    if (bot && TG_CHAT_ID) bot.sendMessage(TG_CHAT_ID, msg, { parse_mode: 'Markdown' }).catch(() => {});
}

function log(message) {
    const timestamp = new Date().toLocaleString('pt-BR');
    const entry = `[${timestamp}] 💎 [FOREX] ${message}`;
    console.log(entry);
    fs.appendFileSync(LOG_FILE, entry + '\n');
}

// ============================================================
// INDICADORES TÉCNICOS
// ============================================================
function calcEMAArray(data, period) {
    const k = 2 / (period + 1);
    return data.reduce((arr, price, i) => {
        arr.push(i === 0 ? price : price * k + arr[i - 1] * (1 - k));
        return arr;
    }, []);
}

function calcRSI(closes, period = 14) {
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) gains += diff; else losses -= diff;
    }
    const rs = gains / (losses || 0.001);
    return 100 - (100 / (1 + rs));
}

// ============================================================
// ANÁLISE: EMA CROSSOVER + RSI (igual ao Scalper Binance)
// ============================================================
async function analyzeSymbol(symbol) {
    try {
        const res = await axios.get(`${BRIDGE_URL}/get_candles?symbol=${symbol}&count=40`, { timeout: 4000 });
        const candles = res.data;
        if (!candles || candles.length < 25) return null;

        const closes = candles.map(c => c.close);
        const currentPrice = closes[closes.length - 1];

        const ema9Arr  = calcEMAArray(closes, 9);
        const ema21Arr = calcEMAArray(closes, 21);

        const ema9Curr  = ema9Arr[ema9Arr.length - 1];
        const ema9Prev  = ema9Arr[ema9Arr.length - 2];
        const ema21Curr = ema21Arr[ema21Arr.length - 1];
        const ema21Prev = ema21Arr[ema21Arr.length - 2];

        const rsi = calcRSI(closes);

        const bullCross = ema9Prev <= ema21Prev && ema9Curr > ema21Curr;
        const bearCross = ema9Prev >= ema21Prev && ema9Curr < ema21Curr;

        let signal = null;
        if (bullCross && rsi > 40 && rsi < 72) signal = 'BUY';
        if (bearCross && rsi > 28 && rsi < 60) signal = 'SELL';

        const trend = ema9Curr > ema21Curr ? 'UP' : 'DOWN';

        return {
            symbol, currentPrice, signal, trend,
            rsi:   rsi.toFixed(1),
            ema9:  ema9Curr.toFixed(5),
            ema21: ema21Curr.toFixed(5),
            zScore: (ema9Curr - ema21Curr) / (ema21Curr * 0.001), // compat. dashboard
            priceHistory: candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }))
        };
    } catch (e) {
        return null;
    }
}

// ============================================================
// MONITORAR POSIÇÃO ABERTA (PnL em tempo real)
// ============================================================
async function monitorPosition() {
    try {
        const res = await axios.get(`${BRIDGE_URL}/get_positions?symbol=${state.activeSymbol}`, { timeout: 3000 });
        const positions = res.data;

        if (!positions || positions.length === 0) {
            // Posição fechada externamente (SL/TP do MT5)
            log(`📋 Posição ${state.activeSymbol} fechada pelo MT5 (SL/TP automático).`);
            state.inPosition   = false;
            state.positionSide = null;
            state.lastTradeTime = Date.now();
            saveState();
            return;
        }

        const totalPnL = positions.reduce((sum, p) => sum + p.profit, 0);

        const takeProfit = totalPnL >= 3.0;
        const stopLoss   = totalPnL <= -2.0;

        if (takeProfit || stopLoss) {
            const reason = stopLoss ? '🛑 STOP' : '💰 ALVO ATINGIDO';
            await closeAllPositions(reason, totalPnL);
        }

        // Atualiza dados do gráfico mesmo em posição
        const upd = await analyzeSymbol(state.activeSymbol);
        if (upd) { state.scannerData[state.activeSymbol] = upd; saveState(); }

    } catch (e) {
        log(`⚠️ ERRO AO MONITORAR: ${e.message}`);
    }
}

// ============================================================
// FECHAR TODAS AS POSIÇÕES
// ============================================================
async function closeAllPositions(reason, profit = 0) {
    try {
        log(`🚨 FECHANDO POSIÇÃO: ${state.activeSymbol} — ${reason}`);
        const res = await axios.post(`${BRIDGE_URL}/close_all`, { symbol: state.activeSymbol }, { timeout: 5000 });
        const realProfit = res.data.profit ?? profit;

        state.dailyProfitUSD += realProfit;
        state.balanceUSD     += realProfit;

        log(`✅ POSIÇÃO ENCERRADA | PnL: $ ${realProfit.toFixed(2)} | Total Hoje: $ ${state.dailyProfitUSD.toFixed(2)}`);
        sendTelegram(`🏁 *FOREX ENCERRADO*\n\nSímbolo: ${state.activeSymbol}\nMotivo: ${reason}\nPnL: $ ${realProfit.toFixed(2)}\nTotal Hoje: $ ${state.dailyProfitUSD.toFixed(2)}`);

        state.inPosition    = false;
        state.positionSide  = null;
        state.lastTradeTime = Date.now();
        saveState();
    } catch (e) {
        log(`❌ ERRO AO FECHAR: ${e.message}`);
    }
}

// ============================================================
// SCANNER PRINCIPAL
// ============================================================
async function runForexScanner() {
    if (state.paused) return;

    // Verifica se o mercado está aberto
    try {
        const accRes = await axios.get(`${BRIDGE_URL}/get_account`, { timeout: 3000 });
        if (!accRes.data.market_open) {
            // Atualiza balanço real da conta MT5
            state.balanceUSD = accRes.data.balance || state.balanceUSD;
            saveState();
            return;
        }
    } catch (e) { return; }

    // Se em posição, monitorar PnL
    if (state.inPosition) {
        await monitorPosition();
        return;
    }

    // Scan paralelo de todos os símbolos
    const cooldownOk = !state.lastTradeTime || (Date.now() - state.lastTradeTime > COOLDOWN_MS);
    if (!cooldownOk) return;

    try {
        const results = await Promise.all(SYMBOLS.map(s => analyzeSymbol(s)));

        for (const result of results) {
            if (!result) continue;
            state.scannerData[result.symbol] = result;

            if (result.signal && !state.inPosition) {
                await openTrade(result.symbol, result.signal, result.currentPrice);
                break;
            }
        }
        saveState();
    } catch (e) {}
}

// ============================================================
// ABRIR TRADE VIA BRIDGE MT5
// ============================================================
async function openTrade(symbol, side, price) {
    if (state.dailyProfitUSD >= 15.0) {
        log(`🏆 META DIÁRIA FOREX ATINGIDA ($ ${state.dailyProfitUSD.toFixed(2)}). Aguardando amanhã.`);
        return;
    }

    try {
        const vol   = SYMBOL_VOLUME[symbol] ?? 0.01;
        const sltp  = SYMBOL_SL_TP[symbol]  ?? { sl: 200, tp: 350 };

        const res = await axios.post(`${BRIDGE_URL}/open_trade`, {
            symbol, side, volume: vol, sl_points: sltp.sl, tp_points: sltp.tp
        }, { timeout: 5000 });

        if (!res.data.success) {
            log(`❌ MT5 REJEITOU ORDEM [${symbol}]: ${res.data.error} (retcode: ${res.data.retcode})`);
            return;
        }

        const data = state.scannerData[symbol];
        log(`🎯 TRADE ABERTO: ${side} em ${symbol} | Entrada: ${price.toFixed(5)} | RSI: ${data?.rsi} | EMA9: ${data?.ema9}`);
        sendTelegram(`🔥 *FOREX TRADE ABERTO*\n\n➡️ Direção: ${side}\n💵 Preço: ${price.toFixed(5)}\n⚙️ Símbolo: ${symbol}`);

        state.inPosition   = true;
        state.entryPrice   = price;
        state.activeSymbol = symbol;
        state.positionSide = side;
        state.lastTradeTime = Date.now();
        saveState();
    } catch (e) {
        const detail = e.response?.data?.error || e.message;
        log(`❌ ERRO AO ABRIR TRADE FOREX [${symbol}]: ${detail}`);
    }
}

// ============================================================
// EXPRESS API
// ============================================================
const app = express();
app.use(cors());
app.use(express.json());
app.use(basicAuth({ users: { 'admin': DASHBOARD_PWD }, challenge: true }));

app.get('/api/stats', (req, res) => res.json(state));
app.get('/api/logs', (req, res) => {
    if (fs.existsSync(LOG_FILE)) res.json(fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-50));
    else res.json([]);
});

app.post('/api/toggle-pause', (req, res) => {
    state.paused = !state.paused;
    log(state.paused ? '⏸️ FOREX SNIPER PAUSADO' : '▶️ FOREX SNIPER RETOMADO');
    saveState();
    res.json({ paused: state.paused });
});

app.post('/api/emergency-exit', async (req, res) => {
    try {
        // Busca PnL real antes de fechar
        const posRes = await axios.get(`${BRIDGE_URL}/get_positions?symbol=${state.activeSymbol}`, { timeout: 3000 });
        const positions = posRes.data || [];
        const currentPnL = positions.reduce((sum, p) => sum + p.profit, 0);
        await closeAllPositions('🚨 Encerrado pelo Usuário (Dashboard)', currentPnL);
        res.json({ success: true });
    } catch (e) {
        await closeAllPositions('🚨 Encerrado pelo Usuário (Dashboard)', 0);
        res.json({ success: true });
    }
});

app.listen(PORT, () => log(`🌐 NÍVEL 10: FOREX SNIPER (CONTROLE REMOTO ATIVO)`));

setInterval(runForexScanner, 3000); // A cada 3s
runForexScanner();
