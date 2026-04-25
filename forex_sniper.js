import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import express from 'express';
import cors from 'cors';
import basicAuth from 'express-basic-auth';

dotenv.config({ path: '.env.trading' });

const BRIDGE_URL = 'http://127.0.0.1:5003';
const PORT = process.env.FOREX_PORT || 5002;
const DASHBOARD_PWD = process.env.DASHBOARD_PASSWORD || '1234';
const LOG_FILE = 'forex_logs.json';
const STATE_FILE = 'forex_state.json';

let state = {
    balanceUSD: 500.0,
    activeSymbol: 'XAUUSD',
    inPosition: false,
    paused: false,
    scannerData: {}
};

if (fs.existsSync(STATE_FILE)) {
    try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE)) }; } catch (e) {}
}

function saveState() { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }

function log(message) {
    const timestamp = new Date().toLocaleString('pt-BR');
    const entry = `[${timestamp}] 💎 [FOREX] ${message}`;
    console.log(entry);
    fs.appendFileSync(LOG_FILE, entry + '\n');
}

async function runForexScanner() {
    if (state.paused) return;
    try {
        const symbols = ['XAUUSD', 'EURUSD', 'GBPUSD'];
        for (const sym of symbols) {
            const res = await axios.get(`${BRIDGE_URL}/get_candles?symbol=${sym}&count=50`, { timeout: 3000 });
            const candles = res.data;
            if (candles.length > 0) {
                const closes = candles.map(c => c.close);
                const currentPrice = closes[closes.length - 1];
                const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
                const stdDev = Math.sqrt(closes.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b, 0) / closes.length);
                const zScore = (currentPrice - mean) / (stdDev || 1);
                
                state.scannerData[sym] = {
                    currentPrice,
                    zScore,
                    priceHistory: candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }))
                };
            }
        }
        saveState();
    } catch (e) {}
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
    log(state.paused ? '⏸️ SNIPER PAUSADO' : '▶️ SNIPER RETOMADO');
    saveState();
    res.json({ paused: state.paused });
});

app.post('/api/emergency-exit', async (req, res) => {
    try {
        log(`🚨 EMERGENCY EXIT: Fechando todas as ordens de ${state.activeSymbol} no MT5`);
        const bridgeRes = await axios.post(`${BRIDGE_URL}/close_all`, { symbol: state.activeSymbol });
        log(`✅ Ordens fechadas: ${bridgeRes.data.count}`);
        state.inPosition = false;
        saveState();
        res.json({ success: true, count: bridgeRes.data.count });
    } catch (e) {
        log(`❌ ERRO AO FECHAR NO MT5: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, () => log(`🌐 NÍVEL 10: FOREX SNIPER (CONTROLE REMOTO ATIVO)`));

setInterval(runForexScanner, 10000);
runForexScanner();
