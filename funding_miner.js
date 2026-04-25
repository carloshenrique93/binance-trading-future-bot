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
// NOTE: polling is FALSE here to avoid conflict with the Scalper bot!
const bot = TG_TOKEN ? new TelegramBot(TG_TOKEN, { polling: false }) : null;

function sendTelegram(msg) {
    if (bot && TG_CHAT_ID) {
        bot.sendMessage(TG_CHAT_ID, msg).catch(e => console.error('Erro Telegram:', e.message));
    }
}

const PORT = process.env.MINER_PORT || 5001;
const DASHBOARD_PWD = process.env.DASHBOARD_PASSWORD || '1234';
const LOG_FILE = 'funding_logs.json';
const STATE_FILE = 'funding_state.json';

const exchangeConfig = {
    apiKey: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_SECRET_KEY,
    enableRateLimit: true,
    options: { defaultType: 'future' }
};

const futuresExchange = new ccxt.binance(exchangeConfig);
const spotExchange = new ccxt.binance({ ...exchangeConfig, options: { defaultType: 'spot' } });

futuresExchange.urls['api']['fapiPublic'] = 'https://demo-fapi.binance.com/fapi/v1';
futuresExchange.urls['api']['fapiPrivate'] = 'https://demo-fapi.binance.com/fapi/v1';
spotExchange.setSandboxMode(true); // Demo Spot

let state = {
    activeHedge: null,
    history: [],
    lastUpdate: new Date().toISOString(),
    nextFundingTime: null,
    paused: false
};

if (fs.existsSync(STATE_FILE)) {
    try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE)) }; } catch (e) {}
}

function saveState() {
    state.lastUpdate = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function log(message) {
    const timestamp = new Date().toLocaleString('pt-BR');
    const entry = `[${timestamp}] ⛏️ ${message}`;
    console.log(entry);
    fs.appendFileSync(LOG_FILE, entry + '\n');
}

async function emergencyExit() {
    if (!state.activeHedge) return;
    try {
        const symbol = state.activeHedge.symbol;
        const base = symbol.split('/')[0];
        log(`🚨 KILL SWITCH ATIVADO: Desmontando Hedge de ${symbol}`);

        // 1. Close Futures Short
        const futSymbol = symbol.replace('/', '').split(':')[0];
        const positions = await futuresExchange.fetchPositions([symbol]);
        const pos = positions.find(p => p.symbol === symbol);
        if (pos && Math.abs(parseFloat(pos.contracts)) > 0) {
            await futuresExchange.createOrder(symbol, 'market', 'buy', Math.abs(pos.contracts), undefined, { 'reduceOnly': true });
            log(`✅ Futures Short Fechado.`);
        }

        // 2. Sell Spot Leg
        const spotSymbol = `${base}/USDT`;
        const balance = await spotExchange.fetchBalance();
        const amount = balance.free[base] || 0;
        if (amount > 0) {
            await spotExchange.createOrder(spotSymbol, 'market', 'sell', amount);
            log(`✅ Spot Leg Vendido. Saldo em USDT restaurado.`);
        }

        state.activeHedge = null;
        saveState();
        log(`🏆 HEDGE DESMONTADO COM SUCESSO.`);
        sendTelegram(`🚨 *HEDGE DESMONTADO*\n\nMoeda: ${symbol}\nMotivo: Saída de Emergência Acionada`);
    } catch (e) {
        log(`❌ ERRO NO KILL SWITCH: ${e.message}`);
    }
}

async function updateFundingData() {
    if (!state.activeHedge) return;
    const symbol = state.activeHedge.symbol.replace('/', '').split(':')[0];
    
    try {
        const income = await futuresExchange.fapiPrivateGetIncome({
            symbol: symbol,
            incomeType: 'FUNDING_FEE',
            limit: 20
        });
        
        if (Array.isArray(income)) {
            let total = 0;
            income.forEach(i => { total += Math.abs(parseFloat(i.income)); });
            if (total > (state.activeHedge.fundingCollected || 0)) {
                const diff = total - (state.activeHedge.fundingCollected || 0);
                log(`💎 PAGAMENTO REAL RECEBIDO (DEMO): +$ ${diff.toFixed(4)}`);
                sendTelegram(`💎 *YIELD COLETADO*\n\nMoeda: ${symbol}\nPagamento: +$ ${diff.toFixed(4)}\nTotal Acumulado: $ ${total.toFixed(4)}`);
                state.activeHedge.fundingCollected = total;
            }
        }
    } catch (e) {
        // Ignora timeout do Demo API para o Income
    }

    try {
        const premium = await futuresExchange.fapiPublicGetPremiumIndex({ symbol: symbol });
        state.nextFundingTime = parseInt(premium.nextFundingTime);
        state.activeHedge.rate = parseFloat(premium.lastFundingRate);
        state.activeHedge.apy = (state.activeHedge.rate * 3 * 365 * 100).toFixed(2);
        saveState();
    } catch (e) {
        // Ignora erros temporários de conexão
    }
}

async function findOpportunities() {
    if (state.paused) return [];
    try {
        const tickers = await futuresExchange.fetchTickers();
        const opportunities = [];
        for (const symbol in tickers) {
            if (symbol.endsWith('/USDT:USDT')) {
                const ticker = tickers[symbol];
                const fundingRate = ticker.info.lastFundingRate || 0;
                opportunities.push({ symbol, rate: parseFloat(fundingRate), apy: (parseFloat(fundingRate) * 3 * 365 * 100).toFixed(2), volume: ticker.quoteVolume });
            }
        }
        return opportunities.sort((a, b) => b.rate - a.rate);
    } catch (e) { return []; }
}

async function monitor() {
    await updateFundingData();
    if (state.activeHedge) {
        const rateDisplay = state.activeHedge.rate ? (state.activeHedge.rate * 100).toFixed(4) : '0.0000';
        log(`Minerando ${state.activeHedge.symbol}: Rate ${rateDisplay}% | Total: $ ${state.activeHedge.fundingCollected?.toFixed(4) || '0.0000'}`);
        return;
    }
    const opps = await findOpportunities();
    if (opps.length > 0 && !state.paused) {
        const best = opps[0];
        state.activeHedge = { symbol: best.symbol, rate: best.rate, apy: best.apy, fundingCollected: 0, startTime: new Date().toISOString() };
        saveState();
        sendTelegram(`⛏️ *NOVA MINERAÇÃO INICIADA*\n\nMoeda: ${best.symbol}\nRate Atual: ${(best.rate * 100).toFixed(4)}%\nAPY Estimado: ${best.apy}%`);
    }
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(basicAuth({ users: { 'admin': DASHBOARD_PWD }, challenge: true }));

app.get('/api/stats', async (req, res) => res.json({ ...state }));
app.get('/api/logs', (req, res) => {
    if (fs.existsSync(LOG_FILE)) res.json(fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-50));
    else res.json([]);
});

app.post('/api/toggle-pause', (req, res) => {
    state.paused = !state.paused;
    log(state.paused ? '⏸️ MINERADOR PAUSADO (NÃO BUSCARÁ NOVAS MOEDAS)' : '▶️ MINERADOR RETOMADO');
    saveState();
    res.json({ paused: state.paused });
});

app.post('/api/emergency-exit', async (req, res) => {
    await emergencyExit();
    res.json({ success: true });
});

app.listen(PORT, () => log(`🌐 NÍVEL 10: FUNDING MINER (CONTROLE REMOTO ATIVO)`));
setInterval(monitor, 30000);
monitor();
