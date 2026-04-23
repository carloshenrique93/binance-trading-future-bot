import ccxt from 'ccxt';
import dotenv from 'dotenv';
import fs from 'fs';
import { RSI, EMA, BollingerBands } from 'technicalindicators';
import express from 'express';
import cors from 'cors';
import basicAuth from 'express-basic-auth';
import TelegramBot from 'node-telegram-bot-api';

dotenv.config({ path: '.env.trading' });

// Configuration
const SYMBOL = 'BTC/USDT';
const TIMEFRAME_ENTRY = '1m';
const LEVERAGE = 5; 
const BANK_BRL = 1000.0; 
const DAILY_TARGET_BRL = 30.0; 
const POSITION_AMOUNT = 0.005;
const STOP_LOSS_BRL = 10.0;    
const TAKE_PROFIT_BRL = 20.0;  // Matemática 2:1 (Elite)
const COOLDOWN_MINUTES = 10;   
const Z_SCORE_THRESHOLD = 2.5; // Extremo Quântico

const STATE_FILE = 'bot_state.json';
const LOG_FILE = 'trading_logs.json';
const PORT = process.env.PORT || 5000;
const DASHBOARD_PWD = process.env.DASHBOARD_PASSWORD || '1234';
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
        const status = state.inPosition ? `🔘 EM ${state.direction} (@ ${state.entryPrice})` : '🔍 CAÇANDO LIQUIDEZ';
        const text = `📊 *BOT STATUS*\n\n💰 Lucro Hoje: R$ ${state.dailyProfitBRL.toFixed(2)}\n🎯 Meta: R$ ${DAILY_TARGET_BRL.toFixed(2)}\n🚀 Estado: ${status}\n📈 Banca: R$ ${(1000 + state.dailyProfitBRL).toFixed(2)}`;
        bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
    });
}

// --- VACINA DEFINITIVA: SILENCIADOR DE FIREWALL ---
const testnet = 'https://testnet.binancefuture.com/fapi/v1';

const exchange = new ccxt.binance({
    apiKey: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_SECRET_KEY,
    enableRateLimit: true,
    options: { 
        defaultType: 'future',
        adjustForTimeDifference: true,
    },
    urls: {
        api: {
            fapiPublic: testnet,
            fapiPrivate: testnet,
            public: testnet,
            private: testnet,
            sapi: 'http://127.0.0.1:9999' // Redireciona SAPI (bloqueado) para o nada
        }
    }
});

// Monkey-patching: Interceptamos a função de rede para ignorar bloqueios do firewall
const originalFetch = exchange.fetch;
exchange.fetch = async function (url, method, headers, body) {
    // Se a URL contém o endereço oficial bloqueado, nós simplesmente "matamos" a requisição
    if (url.includes('api.binance.com')) {
        // Retornamos um erro vazio que o robô possa ignorar
        return {}; 
    }
    try {
        return await originalFetch.apply(this, arguments);
    } catch (e) {
        // Se falhar qualquer coisa que não seja essencial, silenciamos
        if (url.includes('fapi')) throw e; // Só reportamos erro se for nos Futuros
        return {};
    }
};
// -------------------------------------------
let isPaused = false;
let latestFVGs = []; // Armazena os FVGs para a API

let priceHistory = [];
let state = {
    dailyProfitBRL: 0,
    lastUpdate: new Date().toLocaleDateString(),
    inPosition: false,
    direction: '', 
    entryPrice: 0,
    amount: 0,
    maxProfitReached: 0,
    trades: []
};

if (fs.existsSync(STATE_FILE)) {
    state = JSON.parse(fs.readFileSync(STATE_FILE));
}

function saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function log(message, isBox = false) {
    const timestamp = new Date().toLocaleString('pt-BR');
    const entry = isBox ? message : `[${timestamp}] 🤖 ${message}`;
    console.log(entry);
    fs.appendFileSync(LOG_FILE, entry + '\n');
}

async function setupTradeMode() {
    log(`Iniciando Sincronização Silenciosa...`);
    try {
        // Tentamos o básico sem travar o bot
        try { await exchange.setLeverage(LEVERAGE, SYMBOL); } catch (e) {}
        log(`Pronto para agir.`);
        log(`🚀 NÍVEL 8: QUANTUM INSTITUTIONAL ATIVADO (CVD + Z-Score + Triple Screen)`);
        sendTelegram(`✅ *BOT ONLINE: NÍVEL 8 QUÂNTICO*\n\n🧠 Inteligência: CVD + Z-Score Ativos\n📊 Meta: R$ ${DAILY_TARGET_BRL}\n🛡️ Risco: 2:1 Ratio Ativado`);
    } catch (e) {}
}

async function getCVD() {
    try {
        const trades = await exchange.fetchTrades(SYMBOL, undefined, 500);
        let delta = 0;
        trades.forEach(t => {
            if (t.side === 'buy') delta += t.amount;
            else delta -= t.amount;
        });
        return delta;
    } catch (e) { return 0; }
}

function calculateZScore(price, period = 20, values) {
    if (values.length < period) return 0;
    const slice = values.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
    const stdDev = Math.sqrt(variance);
    return (price - mean) / stdDev;
}

function detectFVGs(ohlcv) {
    const fvgs = [];
    // Analisamos as últimas 50 velas para encontrar desequilíbrios
    for (let i = ohlcv.length - 3; i >= ohlcv.length - 50; i--) {
        const c1 = ohlcv[i];   // Vela 1
        const c2 = ohlcv[i+1]; // Vela 2 (A vela do "deslocamento")
        const c3 = ohlcv[i+2]; // Vela 3
        
        // Bullish FVG (Gap de Alta)
        if (c1[2] < c3[3]) { 
            fvgs.push({ type: 'BULLISH', top: c3[3], bottom: c1[2], midpoint: (c3[3] + c1[2]) / 2 });
        }
        // Bearish FVG (Gap de Baixa)
        if (c1[3] > c3[2]) {
            fvgs.push({ type: 'BEARISH', top: c1[3], bottom: c3[2], midpoint: (c1[3] + c3[2]) / 2 });
        }
    }
    return fvgs;
}

async function getIndicators() {
    try {
        const ohlcv1m = await exchange.fetchOHLCV(SYMBOL, '1m', undefined, 300);
        const ohlcv5m = await exchange.fetchOHLCV(SYMBOL, '5m', undefined, 100);
        const ohlcv15m = await exchange.fetchOHLCV(SYMBOL, '15m', undefined, 100);
        
        const closes1m = ohlcv1m.map(x => x[4]);
        const currentPrice = closes1m[closes1m.length - 1];
        
        // Tendências Triple Screen
        const ema200_15m = EMA.calculate({ period: 200, values: ohlcv15m.map(x => x[4]) }).pop();
        const ema200_5m = EMA.calculate({ period: 200, values: ohlcv5m.map(x => x[4]) }).pop();
        const trend15m = ohlcv15m.pop()[4] > ema200_15m ? 'UP' : 'DOWN';
        const trend5m = ohlcv5m.pop()[4] > ema200_5m ? 'UP' : 'DOWN';

        const rsi = RSI.calculate({ values: closes1m, period: 7 }).pop();
        const zScore = calculateZScore(currentPrice, 20, closes1m);
        const fvgs = detectFVGs(ohlcv1m);
        const cvd = await getCVD();
        
        priceHistory = ohlcv1m.map(x => ({ 
            time: x[0] / 1000, 
            open: x[1], 
            high: x[2], 
            low: x[3], 
            close: x[4] 
        })).slice(-30);
        
        return { currentPrice, rsi, fvgs, cvd, zScore, trend15m, trend5m };
    } catch (error) {
        if (error.message.includes('fetch failed')) return null;
        log(`Erro de Dados: ${error.message}`);
        return null;
    }
}

async function run() {
    const today = new Date().toLocaleDateString();
    if (state.lastUpdate !== today) {
        state.dailyProfitBRL = 0;
        state.lastUpdate = today;
        saveState();
    }

    if (isPaused) return;
    if (state.dailyProfitBRL >= DAILY_TARGET_BRL) return;

    try {
        const data = await getIndicators();
        if (!data || !data.fvgs) return;

            const { currentPrice, rsi, fvgs, cvd, zScore, trend15m, trend5m } = data;
            latestFVGs = fvgs;
            const status = isPaused ? '⏸️ PAUSADO' : (state.inPosition ? `🔘 EM ${state.direction}` : '🔍 QUANTUM HUNT');
            
            if (Date.now() % 120000 < 15000) {
                log(`${status} | P: ${currentPrice.toFixed(2)} | CVD: ${cvd.toFixed(1)} | Z: ${zScore.toFixed(2)} | T: ${trend15m}/${trend5m}`);
            }

            if (!state.inPosition) {
                if (state.lastStop) {
                    const diff = (Date.now() - new Date(state.lastStop).getTime()) / 1000 / 60;
                    if (diff < COOLDOWN_MINUTES) return;
                }
                
                let side = '';
                // ESTRATÉGIA NÍVEL 8: QUANTUM INSTITUTIONAL
                const isBullishTrend = trend15m === 'UP' && trend5m === 'UP';
                const isBearishTrend = trend15m === 'DOWN' && trend5m === 'DOWN';

                const recentBullishFVG = fvgs.find(f => f.type === 'BULLISH' && currentPrice <= f.top && currentPrice >= f.bottom);
                const recentBearishFVG = fvgs.find(f => f.type === 'BEARISH' && currentPrice >= f.bottom && currentPrice <= f.top);

                // Entradas Quânticas: FVG + Z-Score Extremo + CVD Favorável
                if (isBullishTrend && recentBullishFVG && zScore < -Z_SCORE_THRESHOLD && cvd > 0) side = 'LONG';
                if (isBearishTrend && recentBearishFVG && zScore > Z_SCORE_THRESHOLD && cvd < 0) side = 'SHORT';

                if (side) {
                    log(`🚀 Abrindo ${side} (Quantum Institutional Entry)...`);
                try {
                    const orderSide = side === 'LONG' ? 'buy' : 'sell';
                    await exchange.createMarketOrder(SYMBOL, orderSide, POSITION_AMOUNT);
                    
                    state.inPosition = true;
                    state.direction = side;
                    state.entryPrice = currentPrice;
                    state.amount = POSITION_AMOUNT;
                    state.maxProfitReached = 0;
                    state.trades.push({ type: side, price: currentPrice, time: new Date().toISOString() });
                    
                    const statusMsg = `🚀 NOVO TRADE ABERTO: ${side} | Preço: ${currentPrice.toFixed(2)} | Alavancagem: ${LEVERAGE}x`;
                    log(statusMsg);
                    sendTelegram(`🔥 *NOVO TRADE ABERTO*\n\n➡️ Direção: ${side}\n💵 Preço: $${currentPrice.toFixed(2)}\n⚙️ Alavancagem: ${LEVERAGE}x`);
                    saveState();
                } catch (e) { log(`❌ Ordem negada: ${e.message}`); }
            }
        } else {
            const isLong = state.direction === 'LONG';
            const priceChange = isLong ? 
                (currentPrice - state.entryPrice) / state.entryPrice :
                (state.entryPrice - currentPrice) / state.entryPrice;
            
            const currentBRLResult = priceChange * BANK_BRL * LEVERAGE;

            // Atualiza o lucro máximo para o Trailing Stop
            if (currentBRLResult > state.maxProfitReached) {
                state.maxProfitReached = currentBRLResult;
            }

            // GESTÃO DE SAÍDA QUÂNTICA (Strict 2:1)
            const takeProfit = currentBRLResult >= TAKE_PROFIT_BRL; 
            const stopLoss = currentBRLResult <= -STOP_LOSS_BRL; 

            if (takeProfit || stopLoss) {
                const reason = stopLoss ? '🛑 STOP' : '💰 ALVO QUÂNTICO';
                try {
                    const orderSide = isLong ? 'sell' : 'buy';
                    await exchange.createMarketOrder(SYMBOL, orderSide, state.amount, { 'reduceOnly': true });
                    
                    state.dailyProfitBRL += currentBRLResult;
                    const statusMsg = `🏁 POSIÇÃO ENCERRADA (${reason}) | Lucro: R$ ${currentBRLResult.toFixed(2)} | Total Hoje: R$ ${state.dailyProfitBRL.toFixed(2)} / Meta: R$ ${DAILY_TARGET_BRL.toFixed(2)}`;
                    log(statusMsg);
                    const emoji = currentBRLResult >= 0 ? '💰' : '❌';
                    sendTelegram(`${emoji} *POSIÇÃO ENCERRADA*\n\n🏁 Motivo: ${reason}\n💸 Lucro: R$ ${currentBRLResult.toFixed(2)}\n📊 Total Hoje: R$ ${state.dailyProfitBRL.toFixed(2)}`);

                    if (currentBRLResult < 0) {
                        state.lastStop = new Date().toISOString();
                        log(`⏸️ COOLDOWN ATIVADO: Aguardando ${COOLDOWN_MINUTES}min para estabilização.`);
                    }

                    state.inPosition = false;
                    state.trades.push({ type: 'CLOSE', price: currentPrice, profit: currentBRLResult, time: new Date().toISOString(), reason });
                    saveState();
                } catch (e) { log(`❌ Erro no fechamento: ${e.message}`); }
            }
        }
    } catch (e) {}
}


const app = express();
app.use(cors());
app.use(basicAuth({ users: { 'admin': DASHBOARD_PWD }, challenge: true }));
app.get('/api/stats', (req, res) => res.json({...state, priceHistory, isPaused, fvgs: latestFVGs })); 
app.get('/api/logs', (req, res) => {
    if (fs.existsSync(LOG_FILE)) res.json(fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-60));
    else res.json([]);
});

app.post('/api/toggle-pause', (req, res) => {
    isPaused = !isPaused;
    log(isPaused ? '⏸️ Bot Pausado manualmente' : '▶️ Bot Retomado manualmente');
    res.json({ isPaused });
});

app.post('/api/close-position', async (req, res) => {
    if (!state.inPosition) return res.status(400).json({ error: 'Nenhuma posição aberta' });
    log('⚠️ Fechamento manual solicitado via Dashboard');
    
    try {
        const isLong = state.direction === 'LONG';
        const orderSide = isLong ? 'sell' : 'buy';
        await exchange.createMarketOrder(SYMBOL, orderSide, state.amount, { 'reduceOnly': true });
        
        // Calculamos o lucro aproximado no momento do fechamento manual
        const data = await getIndicators();
        let profit = 0;
        if (data) {
            const currentPrice = data.currentPrice;
            const priceChange = isLong ? 
                (currentPrice - state.entryPrice) / state.entryPrice :
                (state.entryPrice - currentPrice) / state.entryPrice;
            profit = priceChange * BANK_BRL * LEVERAGE;
        }

        state.inPosition = false;
        state.dailyProfitBRL += profit;
        state.trades.push({ type: 'CLOSE_MANUAL', time: new Date().toISOString(), profit });
        saveState();
        res.json({ success: true });
    } catch (e) {
        log(`❌ Erro no fechamento manual: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

const server = app.listen(PORT, () => log(`🌐 API Dashboard ativa.`)).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n❌ ERRO CRÍTICO: Já existe um robô rodando nesta porta (${PORT})!`);
        console.error(`Encerrando esta instância para evitar ordens duplicadas.\n`);
        process.exit(1);
    }
});

setupTradeMode();
setInterval(run, 15000); 
run();
