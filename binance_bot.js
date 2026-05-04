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
// Precisão de quantidade aceita pela Binance por símbolo (casas decimais)
const SYMBOL_QTY_PRECISION = { 'BTC/USDT': 3, 'ETH/USDT': 2, 'SOL/USDT': 0 };
// MODO CONTRARIAN: inverte o sinal (LONG vira SHORT e vice-versa)
// Ativo porque o bot estava operando consistentemente no lado errado do mercado
const CONTRARIAN_MODE = true;
const PORT = process.env.SCALPER_PORT || 5000;
const DASHBOARD_PWD = process.env.DASHBOARD_PASSWORD || '1234';
const LOG_FILE = 'trading_logs.json';
const STATE_FILE = 'trading_state.json';

const exchange = new ccxt.binance({
    apiKey: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_SECRET_KEY,
    enableRateLimit: true,
    timeout: 30000, // Aumenta timeout para 30s (Testnet é lenta)
    options: { 
        defaultType: 'future',
        adjustForTimeDifference: true, // Sincroniza relógio local com a Binance
        recvWindow: 60000 // Janela maior para evitar erro -1021
    }
});

const publicExchange = new ccxt.binance({
    enableRateLimit: true,
    timeout: 30000,
    options: { defaultType: 'future' }
});

exchange.urls['api']['fapiPublic'] = 'https://demo-fapi.binance.com/fapi/v1';
exchange.urls['api']['fapiPrivate'] = 'https://demo-fapi.binance.com/fapi/v1';
exchange.urls['api']['fapiPrivateV2'] = 'https://demo-fapi.binance.com/fapi/v2';
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

// Reseta o PnL diário se a data mudou
const today = new Date().toDateString();
if (state.lastProfitDate !== today) {
    state.dailyProfitUSD = 0;
    state.lastProfitDate = today;
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
        const positions = await exchange.fapiPrivateV2GetPositionRisk({ symbol: state.activeSymbol.replace('/', '') });
        const pos = positions && positions.length > 0 ? positions[0] : null;
        
        if (pos && parseFloat(pos.positionAmt) !== 0) {
            const side = parseFloat(pos.positionAmt) > 0 ? 'SELL' : 'BUY';
            
            await exchange.fapiPrivatePostOrder({
                symbol: state.activeSymbol.replace('/', ''),
                side: side,
                type: 'MARKET',
                quantity: Math.abs(parseFloat(pos.positionAmt)),
                reduceOnly: 'true'
            });
            
            state.dailyProfitUSD += profit;
            state.balanceUSD += profit;
            
            log(`✅ POSIÇÃO ENCERRADA | PnL: $ ${profit.toFixed(2)} | Total Hoje: $ ${state.dailyProfitUSD.toFixed(2)}`);
            sendTelegram(`🏁 *POSIÇÃO ENCERRADA*\n\nSímbolo: ${state.activeSymbol}\nMotivo: ${reason}\nLucro Estimado: $ ${profit.toFixed(2)}\nTotal Hoje: $ ${state.dailyProfitUSD.toFixed(2)}`);
        } else {
            sendTelegram(`🏁 *POSIÇÃO ENCERRADA*\n\nSímbolo: ${state.activeSymbol}\nMotivo: Fechado na Exchange`);
        }
        
        state.inPosition = false;
        state.entryPrice = 0;
        state.positionSide = null;
        state.lastTradeTime = Date.now(); // Inicia o cooldown
        saveState();
    } catch (e) {
        log(`❌ ERRO AO FECHAR POSIÇÃO: ${e.message}`);
    }
}

// ============================================================
// INDICADORES TÉCNICOS
// ============================================================
function calcEMA(data, period) {
    const k = 2 / (period + 1);
    return data.reduce((ema, price, i) => i === 0 ? price : price * k + ema * (1 - k), data[0]);
}

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
// ANÁLISE: EMA CROSSOVER + RSI (TREND-FOLLOWING SCALPER)
// ============================================================
async function analyzeSymbol(symbol) {
    try {
        const ohlcv = await publicExchange.fetchOHLCV(symbol, '1m', undefined, 40);
        const closes = ohlcv.map(x => x[4]);
        const currentPrice = closes[closes.length - 1];

        // EMA rápida (9) e lenta (21)
        const ema9Arr  = calcEMAArray(closes, 9);
        const ema21Arr = calcEMAArray(closes, 21);

        const ema9Curr  = ema9Arr[ema9Arr.length - 1];
        const ema9Prev  = ema9Arr[ema9Arr.length - 2];
        const ema21Curr = ema21Arr[ema21Arr.length - 1];
        const ema21Prev = ema21Arr[ema21Arr.length - 2];

        const rsi = calcRSI(closes);

        // Cruzamento acabou de acontecer (sinal fresco)
        const bullCross = ema9Prev <= ema21Prev && ema9Curr > ema21Curr;
        const bearCross = ema9Prev >= ema21Prev && ema9Curr < ema21Curr;

        let signal = null;
        // LONG: cruzamento de alta + RSI não sobrecomprado
        if (bullCross && rsi > 40 && rsi < 72) signal = 'LONG';
        // SHORT: cruzamento de baixa + RSI não sobrevendido
        if (bearCross && rsi > 28 && rsi < 60) signal = 'SHORT';

        const trend = ema9Curr > ema21Curr ? 'UP' : 'DOWN';

        return {
            symbol, currentPrice, signal, trend,
            rsi: rsi.toFixed(1),
            ema9: ema9Curr.toFixed(2),
            ema21: ema21Curr.toFixed(2),
            zScore: (ema9Curr - ema21Curr) / (ema21Curr * 0.001), // compat. dashboard
            priceHistory: ohlcv.map(x => ({ time: x[0]/1000, open: x[1], high: x[2], low: x[3], close: x[4] }))
        };
    } catch (e) {
        if (!e.message.includes('fetch failed') && !e.message.includes('timed out')) {
            log(`⚠️ FALHA DE REDE: Não foi possível ler o gráfico de ${symbol} (${e.message})`);
        }
        return null;
    }
}

async function runScanner() {
    if (state.paused) return;

    if (state.inPosition) {
        try {
            const positions = await exchange.fapiPrivateV2GetPositionRisk({ symbol: state.activeSymbol.replace('/', '') });
            const pos = positions && positions.length > 0 ? positions[0] : null;

            if (pos && parseFloat(pos.positionAmt) !== 0) {
                const currentUSDResult = parseFloat(pos.unRealizedProfit);
                
                // Rastreia o pico de lucro para o Trailing Stop
                state.maxProfitUSD = Math.max(state.maxProfitUSD || 0, currentUSDResult);

                let dynamicStopLoss = -5.0;
                if (state.maxProfitUSD >= 4.0) {
                    dynamicStopLoss = 2.0;  // Garante +$2.00
                } else if (state.maxProfitUSD >= 2.5) {
                    dynamicStopLoss = 0.0;  // Breakeven (Zero a zero)
                }

                const takeProfit = currentUSDResult >= 6.0;
                const stopLoss   = currentUSDResult <= dynamicStopLoss;

                if (takeProfit || stopLoss) {
                    let reason = '🛑 STOP';
                    if (takeProfit) reason = '💰 ALVO ATINGIDO';
                    else if (dynamicStopLoss > 0) reason = '🛡️ TRAILING STOP (LUCRO GARANTIDO)';
                    else if (dynamicStopLoss === 0) reason = '🛡️ BREAKEVEN (SAÍDA NO ZERO)';
                    
                    await closePosition(reason, currentUSDResult);
                }
            } else {
                state.inPosition = false;
                state.positionSide = null;
                saveState();
            }
        } catch(e) {
            if (e.message.includes('fetch failed') || e.message.includes('timed out')) {
                log(`📡 INFO: Testnet oscilando (Falha de rede temporária ignorada).`);
            } else {
                log(`⚠️ ERRO AO MONITORAR POSIÇÃO: ${e.message}`);
            }
        }
    }

// Guard para evitar abertura dupla de trade (race condition no scan paralelo)
let isOpening = false;

// ---- SCAN PARALELO (todos os símbolos ao mesmo tempo) ----
    try {
        const cooldownOk = !state.lastTradeTime || (Date.now() - state.lastTradeTime > 15000);
        
        const results = await Promise.all(SYMBOLS.map(s => analyzeSymbol(s)));
        
        for (const result of results) {
            if (!result) continue;
            state.scannerData[result.symbol] = result;

            if (result.signal && !state.inPosition && cooldownOk && !isOpening) {
                isOpening = true; // Trava imediata antes do await
                try {
                    await openTrade(result.symbol, result.signal, result.currentPrice);
                } finally {
                    isOpening = false;
                }
                break;
            }
        }
        saveState();
    } catch (e) {}
}

async function openTrade(symbol, side, price) {
    if (state.dailyProfitUSD >= 100.0) {
        log(`🏆 META DIÁRIA ATINGIDA ($ ${state.dailyProfitUSD.toFixed(2)}). Aguardando amanhã.`);
        return;
    }

    // MODO CONTRARIAN: inverte o sinal para operar no sentido oposto
    if (CONTRARIAN_MODE) {
        side = side === 'LONG' ? 'SHORT' : 'LONG';
    }
    
    try {
        const orderSide = side === 'LONG' ? 'BUY' : 'SELL';
        
        // Calcula a quantidade com a precisão correta para cada símbolo
        const precision = SYMBOL_QTY_PRECISION[symbol] ?? 2;
        const rawAmount = 500 / price;
        const factor = Math.pow(10, precision);
        const amountStr = (Math.floor(rawAmount * factor) / factor).toFixed(precision);
        
        try { 
            await exchange.fapiPrivatePostLeverage({
                symbol: symbol.replace('/', ''),
                leverage: 5
            }); 
        } catch(e) {}
        
        await exchange.fapiPrivatePostOrder({
            symbol: symbol.replace('/', ''),
            side: orderSide,
            type: 'MARKET',
            quantity: parseFloat(amountStr)
        });
        
        const tp = (side === 'LONG' ? price * 1.006 : price * 0.994).toFixed(2);
        const sl = (side === 'LONG' ? price * 0.995 : price * 1.005).toFixed(2);
        const data = state.scannerData[symbol];
        log(`🎯 TRADE ABERTO: ${side} em ${symbol} | Entrada: $${price.toFixed(2)} | TP: $${tp} | SL: $${sl} | RSI: ${data?.rsi} | EMA9>${data?.ema9} EMA21>${data?.ema21}`);
        sendTelegram(`🔥 *NOVO TRADE ABERTO*\n\n➡️ Direção: ${side}\n💵 Preço: $${price.toFixed(2)}\n🎯 TP: $${tp} | 🛑 SL: $${sl}\n⚙️ Símbolo: ${symbol}`);
        state.inPosition = true;
        state.entryPrice = price;
        state.activeSymbol = symbol;
        state.positionSide = side;
        state.maxProfitUSD = 0; // RESET TRAILING STOP TRACKER
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
    try {
        // Busca o PnL real antes de fechar
        let currentPnL = 0;
        if (state.inPosition && state.activeSymbol) {
            const positions = await exchange.fapiPrivateV2GetPositionRisk({ symbol: state.activeSymbol.replace('/', '') });
            const pos = positions && positions.length > 0 ? positions[0] : null;
            if (pos) currentPnL = parseFloat(pos.unRealizedProfit) || 0;
        }
        await closePosition('🚨 Encerrado pelo Usuário (Dashboard)', currentPnL);
        res.json({ success: true });
    } catch(e) {
        await closePosition('🚨 Encerrado pelo Usuário (Dashboard)', 0);
        res.json({ success: true });
    }
});

app.listen(PORT, () => log(`🌐 NÍVEL 10: SCALPER ONLINE (CONTROLE REMOTO ATIVO)`));

setInterval(runScanner, 5000); // 5s para evitar bloqueio de IP da Testnet
runScanner();
