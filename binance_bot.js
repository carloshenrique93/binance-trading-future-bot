import ccxt from 'ccxt';
import dotenv from 'dotenv';
import fs from 'fs';
import { RSI } from 'technicalindicators';
import express from 'express';
import cors from 'cors';
import basicAuth from 'express-basic-auth';

dotenv.config({ path: '.env.trading' });

// Configuration
const SYMBOL = 'BTC/USDT';
const TIMEFRAME_ENTRY = '1m';
const LEVERAGE = 3; 
const BANK_BRL = parseFloat(process.env.INITIAL_BANK_BRL || 100.0);
const DAILY_TARGET_BRL = parseFloat(process.env.DAILY_TARGET_BRL || 1.0);
const STATE_FILE = 'bot_state.json';
const LOG_FILE = 'trading_logs.json';
const PORT = process.env.PORT || 5000;
const DASHBOARD_PWD = process.env.DASHBOARD_PASSWORD || '1234';

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

let priceHistory = [];
let state = {
    dailyProfitBRL: 0,
    lastUpdate: new Date().toLocaleDateString(),
    inPosition: false,
    direction: '', 
    entryPrice: 0,
    amount: 0,
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
    } catch (e) {}
}

async function getIndicators() {
    try {
        const ohlcv = await exchange.fetchOHLCV(SYMBOL, TIMEFRAME_ENTRY, undefined, 30);
        const closes = ohlcv.map(x => x[4]);
        const currentPrice = closes[closes.length - 1];
        const rsiValues = RSI.calculate({ values: closes, period: 7 }); 
        
        priceHistory = ohlcv.map(x => ({ time: x[0] / 1000, value: x[4] }));
        
        return {
            currentPrice: currentPrice,
            rsi1m: rsiValues[rsiValues.length - 1]
        };
    } catch (error) {
        // Silenciamos erro de log para não poluir o terminal, apenas se for crítico
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

    if (state.dailyProfitBRL >= DAILY_TARGET_BRL) return;

    try {
        const data = await getIndicators();
        if (!data) return;

        const { currentPrice, rsi1m } = data;
        const status = state.inPosition ? `🔘 EM ${state.direction}` : '🔍 MONITORANDO';
        process.stdout.write(`\r${status} | P: ${currentPrice.toFixed(2)} | RSI: ${rsi1m?.toFixed(1)}    `);

        if (!state.inPosition) {
            let side = '';
            if (rsi1m < 40) side = 'LONG';
            if (rsi1m > 60) side = 'SHORT';

            if (side) {
                log(`🚀 Abrindo ${side}...`);
                const marginToUse = 10; 
                const amount = (marginToUse * LEVERAGE) / currentPrice;

                try {
                    const orderSide = side === 'LONG' ? 'buy' : 'sell';
                    await exchange.createMarketOrder(SYMBOL, orderSide, amount);
                    
                    state.inPosition = true;
                    state.direction = side;
                    state.entryPrice = currentPrice;
                    state.amount = amount;
                    state.trades.push({ type: side, price: currentPrice, time: new Date().toISOString() });
                    
                    const box = `
┌────────────────────────────────────────────────────────┐
│ 🔥 NOVO TRADE ABERTO: ${side}                   │
├────────────────────────────────────────────────────────┤
│ Preço: ${currentPrice.toFixed(2)} | Alavancagem: ${LEVERAGE}x        │
└────────────────────────────────────────────────────────┘`;
                    log(box, true);
                    saveState();
                } catch (e) { log(`❌ Ordem negada: ${e.message}`); }
            }
        } else {
            const isLong = state.direction === 'LONG';
            const priceChange = isLong ? 
                (currentPrice - state.entryPrice) / state.entryPrice :
                (state.entryPrice - currentPrice) / state.entryPrice;
            
            const currentBRLResult = priceChange * BANK_BRL * LEVERAGE;

            const exitProfit = currentBRLResult >= 0.05;
            const exitRSI = isLong ? rsi1m > 65 : rsi1m < 35;
            const isStopLoss = currentBRLResult <= -0.50;

            if (exitProfit || exitRSI || isStopLoss) {
                const reason = isStopLoss ? '🛑 STOP' : (exitProfit ? '💰 LUCRO' : '⚠️ RSI');
                try {
                    const orderSide = isLong ? 'sell' : 'buy';
                    await exchange.createMarketOrder(SYMBOL, orderSide, state.amount, { 'reduceOnly': true });
                    
                    const finalBanca = BANK_BRL + state.dailyProfitBRL + currentBRLResult;
                    const box = `
┌────────────────────────────────────────────────────────┐
│ 🏁 POSIÇÃO ENCERRADA (${reason})                  │
├────────────────────────────────────────────────────────┤
│ Lucro: R$ ${currentBRLResult.toFixed(2)} | Meta Hoje: ${state.dailyProfitBRL.toFixed(2)}    │
└────────────────────────────────────────────────────────┘`;
                    log(box, true);

                    state.inPosition = false;
                    state.dailyProfitBRL += currentBRLResult;
                    state.trades.push({ type: 'CLOSE', price: currentPrice, profit: currentBRLResult, time: new Date().toISOString(), reason });
                    saveState();
                } catch (e) { log(`❌ Erro no fechamento: ${e.message}`); }
            }
        }
    } catch (e) {}
}

log(`🚀 NÍVEL 4: MODO SILENCIOSO ATIVADO (ANTI-FIREWALL FINAL)`);
const app = express();
app.use(cors());
app.use(basicAuth({ users: { 'admin': DASHBOARD_PWD }, challenge: true }));
app.get('/api/stats', (req, res) => res.json({...state, priceHistory })); 
app.get('/api/logs', (req, res) => {
    if (fs.existsSync(LOG_FILE)) res.json(fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-60));
    else res.json([]);
});
app.listen(PORT, () => log(`🌐 API Dashboard ativa.`));

setupTradeMode();
setInterval(run, 15000); 
run();
