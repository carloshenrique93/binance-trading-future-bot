import ccxt from 'ccxt';
import dotenv from 'dotenv';
import fs from 'fs';
import express from 'express';
import cors from 'cors';
import basicAuth from 'express-basic-auth';
import TelegramBot from 'node-telegram-bot-api';

dotenv.config({ path: '.env.trading' });

const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const bot = TG_TOKEN ? new TelegramBot(TG_TOKEN, { polling: true }) : null;

function sendTelegram(msg) {
    if (bot && TG_CHAT_ID) {
        bot.sendMessage(TG_CHAT_ID, msg).catch(e => console.error('Erro Telegram:', e.message));
    }
}

if (bot) {
    bot.onText(/\/status/, (msg) => {
        const status = state.inPosition ? `🔘 EM ${state.activeSymbol}` : '🔍 SCANNING';
        const text = `📊 *BOT STATUS*\n\n💰 Lucro Hoje: $ ${state.dailyProfitUSD.toFixed(2)}\n🚀 Estado: ${status}`;
        bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
    });
    
    // Previne que falhas de conexão derrubem o robô
    bot.on('polling_error', (error) => {
        // Ignora silenciosamente erros de ECONNRESET/EFATAL
    });
}

// Configuration
const SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
const Z_SCORE_THRESHOLD = 1.2; // Sensibilidade Agressiva (Micro-Scalping)
const PORT = process.env.SCALPER_PORT || 5000;
const DASHBOARD_PWD = process.env.DASHBOARD_PASSWORD || '1234';
const LOG_FILE = 'trading_logs.json';
const STATE_FILE = 'trading_state.json';

const exchange = new ccxt.binance({
    apiKey: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_SECRET_KEY,
    enableRateLimit: true,
    options: { defaultType: 'future' }
});

const publicExchange = new ccxt.binance({
    enableRateLimit: true,
    options: { defaultType: 'future' }
});

exchange.urls['api']['fapiPublic'] = 'https://demo-fapi.binance.com/fapi/v1';
exchange.urls['api']['fapiPrivate'] = 'https://demo-fapi.binance.com/fapi/v1';
publicExchange.urls['api']['fapiPublic'] = 'https://demo-fapi.binance.com/fapi/v1';
exchange.urls['api']['public'] = 'https://demo-fapi.binance.com/fapi/v1';
exchange.urls['api']['private'] = 'https://demo-fapi.binance.com/fapi/v1';
publicExchange.urls['api']['public'] = 'https://demo-fapi.binance.com/fapi/v1';

let state = {
    balanceUSD: 1000.0,
    dailyProfitUSD: 0,
    activeSymbol: 'BTC/USDT',
    inPosition: false,
    entryPrice: 0,
    paused: false,
    scannerData: {}
};

if (fs.existsSync(STATE_FILE)) {
    try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE)) }; } catch (e) {}
}

function saveState() { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }

function log(message, dashboardOnly = false) {
    const timestamp = new Date().toLocaleString('pt-BR');
    const entry = `[${timestamp}] ⚡ ${message}`;
    if (!dashboardOnly) console.log(entry);
    fs.appendFileSync(LOG_FILE, entry + '\n');
}

async function closePosition(reason = 'Saída de Emergência', profit = 0) {
    if (!state.inPosition) return;
    try {
        log(`🚨 FECHANDO POSIÇÃO: ${state.activeSymbol} - Motivo: ${reason}`);
        const positions = await exchange.fetchPositions([state.activeSymbol]);
        const pos = positions.find(p => p.symbol === state.activeSymbol);
        
        if (pos && parseFloat(pos.contracts) !== 0) {
            const side = parseFloat(pos.contracts) > 0 ? 'sell' : 'buy';
            await exchange.createOrder(state.activeSymbol, 'market', side, Math.abs(pos.contracts), undefined, { 'reduceOnly': true });
            log(`✅ POSIÇÃO ENCERRADA COM SUCESSO.`);
            
            state.dailyProfitUSD += profit;
            sendTelegram(`🏁 *POSIÇÃO ENCERRADA*\n\nSímbolo: ${state.activeSymbol}\nMotivo: ${reason}\nLucro Estimado: $ ${profit.toFixed(2)}\nTotal Hoje: $ ${state.dailyProfitUSD.toFixed(2)}`);
        } else {
            sendTelegram(`🏁 *POSIÇÃO ENCERRADA*\n\nSímbolo: ${state.activeSymbol}\nMotivo: Fechado na Exchange`);
        }
        
        state.inPosition = false;
        state.entryPrice = 0;
        saveState();
    } catch (e) {
        log(`❌ ERRO AO FECHAR POSIÇÃO: ${e.message}`);
    }
}

async function analyzeSymbol(symbol) {
    try {
        const ohlcv = await publicExchange.fetchOHLCV(symbol, '1m', undefined, 50);
        const closes = ohlcv.map(x => x[4]);
        const currentPrice = closes[closes.length - 1];
        
        const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
        const stdDev = Math.sqrt(closes.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b, 0) / closes.length);
        const zScore = (currentPrice - mean) / (stdDev || 1);

        let signal = null;
        if (zScore > Z_SCORE_THRESHOLD) signal = 'SHORT';
        if (zScore < -Z_SCORE_THRESHOLD) signal = 'LONG';

        return { symbol, currentPrice, zScore, signal, trend: zScore > 0 ? 'UP' : 'DOWN', priceHistory: ohlcv.map(x => ({ time: x[0]/1000, open: x[1], high: x[2], low: x[3], close: x[4] })) };
    } catch (e) { 
        log(`⚠️ FALHA DE REDE: Não foi possível ler o gráfico de ${symbol} (${e.message})`);
        return null; 
    }
}

async function runScanner() {
    if (state.paused) return;
    
    if (state.inPosition) {
        try {
            const positions = await exchange.fetchPositions([state.activeSymbol]);
            const pos = positions.find(p => p.symbol === state.activeSymbol);
            if (pos && parseFloat(pos.contracts) !== 0) {
                const currentPrice = parseFloat(pos.markPrice);
                const isLong = parseFloat(pos.contracts) > 0;
                const priceChange = isLong ? 
                    (currentPrice - state.entryPrice) / state.entryPrice :
                    (state.entryPrice - currentPrice) / state.entryPrice;
                
                const currentUSDResult = priceChange * 500; // Posição nominal de $500 (Margem de $100 x 5)
                
                const takeProfit = currentUSDResult >= 1.5; // Alvo Rápido (+$ 1.50)
                const stopLoss = currentUSDResult <= -1.0;  // Stop Curto (-$ 1.00)
                
                if (takeProfit || stopLoss) {
                    const reason = stopLoss ? '🛑 STOP' : '💰 ALVO ATINGIDO';
                    await closePosition(reason, currentUSDResult);
                }
            } else {
                state.inPosition = false;
                saveState();
            }
        } catch(e) {}
        return; // Enquanto em posição, não escaneia novos ativos
    }

    try {
        for (const sym of SYMBOLS) {
            const result = await analyzeSymbol(sym);
            if (result) {
                state.scannerData[sym] = result;
                if (result.signal && !state.inPosition) {
                    await openTrade(sym, result.signal, result.currentPrice);
                }
            }
        }
        saveState();
    } catch (e) {}
}

async function openTrade(symbol, side, price) {
    if (state.dailyProfitUSD >= 10.0) {
        log(`🏆 META DIÁRIA ATINGIDA ($ ${state.dailyProfitUSD.toFixed(2)}). Aguardando amanhã.`);
        return;
    }
    
    try {
        await exchange.loadMarkets(); // CCXT uses internal caching automatically
        
        const orderSide = side === 'LONG' ? 'buy' : 'sell';
        const amount = exchange.amountToPrecision(symbol, 500 / price); // Posição Nominal $500
        
        try { await exchange.setLeverage(5, symbol); } catch(e) {}
        await exchange.createMarketOrder(symbol, orderSide, parseFloat(amount));
        
        log(`🎯 TRADE ABERTO: ${side} em ${symbol} (Z: ${state.scannerData[symbol].zScore.toFixed(2)})`);
        sendTelegram(`🔥 *NOVO TRADE ABERTO*\n\n➡️ Direção: ${side}\n💵 Preço: $${price.toFixed(2)}\n⚙️ Símbolo: ${symbol}`);
        state.inPosition = true;
        state.entryPrice = price;
        state.activeSymbol = symbol;
        saveState();
    } catch(e) {
        log(`❌ ERRO AO ABRIR TRADE: ${e.message}`);
    }
}

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
    log(state.paused ? '⏸️ ROBÔ PAUSADO PELO USUÁRIO' : '▶️ ROBÔ RETOMADO PELO USUÁRIO');
    saveState();
    res.json({ paused: state.paused });
});

app.post('/api/emergency-exit', async (req, res) => {
    await closePosition();
    res.json({ success: true });
});

app.listen(PORT, () => log(`🌐 NÍVEL 10: SCALPER ONLINE (CONTROLE REMOTO ATIVO)`));

setInterval(runScanner, 5000);
runScanner();
