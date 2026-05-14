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
// Desativado para seguir a tendência junto com o filtro M15
const CONTRARIAN_MODE = false;
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

exchange.enableDemoTrading(true);
publicExchange.enableDemoTrading(true);

let state = {
    balanceUSD: 1000.0,
    dailyProfitUSD: 0,
    activeSymbol: 'BTC/USDT',
    inPosition: false,
    entryPrice: 0,
    paused: false,
    scannerData: {}
};

// Guard para evitar abertura dupla de trade (race condition no scan paralelo)
let isOpening = false;

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
            
            // Cancela o STOP físico de emergência (se houver)
            try {
                await exchange.fapiPrivateDeleteAllOpenOrders({ symbol: state.activeSymbol.replace('/', '') });
                log(`🧹 Ordens de proteção canceladas na corretora.`);
            } catch(e) {}

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
function calcSMA(data, period) {
    if (data.length < period) return 0;
    const slice = data.slice(-period);
    const sum = slice.reduce((a, b) => a + b, 0);
    return sum / period;
}

function calcATR(highs, lows, closes, period = 14) {
    let trs = [];
    for (let i = 1; i < closes.length; i++) {
        const tr1 = highs[i] - lows[i];
        const tr2 = Math.abs(highs[i] - closes[i - 1]);
        const tr3 = Math.abs(lows[i] - closes[i - 1]);
        trs.push(Math.max(tr1, tr2, tr3));
    }
    if (trs.length < period) return 0;
    let atr = trs.slice(0, period).reduce((a,b)=>a+b,0)/period;
    for (let i = period; i < trs.length; i++) {
        atr = (atr * (period - 1) + trs[i]) / period;
    }
    return atr;
}

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
        const ohlcv15 = await publicExchange.fetchOHLCV(symbol, '15m', undefined, 40); // Filtro M15 (Maré Alta)
        
        const closes = ohlcv.map(x => x[4]);
        const highs = ohlcv.map(x => x[2]);
        const lows = ohlcv.map(x => x[3]);
        const volumes = ohlcv.map(x => x[5]);
        const closes15 = ohlcv15.map(x => x[4]);
        const currentPrice = closes[closes.length - 1];

        // Volatilidade (ATR) e Volume (SMA)
        const atrValue = calcATR(highs, lows, closes, 14);
        const volumeSMA = calcSMA(volumes.slice(0, -1), 20); // Média de volume
        const currentVolume = volumes[volumes.length - 1]; // Volume atual
        const isVolumeSpike = currentVolume > (volumeSMA * 1.5); // Filtro de Tubarão

        // EMA rápida (9) e lenta (21)
        const ema9Arr  = calcEMAArray(closes, 9);
        const ema21Arr = calcEMAArray(closes, 21);

        // EMA M15
        const ema9Arr15  = calcEMAArray(closes15, 9);
        const ema21Arr15 = calcEMAArray(closes15, 21);
        const trend15m = ema9Arr15[ema9Arr15.length - 1] > ema21Arr15[ema21Arr15.length - 1] ? 'UP' : 'DOWN';

        const ema9Curr  = ema9Arr[ema9Arr.length - 1];
        const ema9Prev  = ema9Arr[ema9Arr.length - 2];
        const ema21Curr = ema21Arr[ema21Arr.length - 1];
        const ema21Prev = ema21Arr[ema21Arr.length - 2];

        const rsi = calcRSI(closes);

        // Cruzamento acabou de acontecer (sinal fresco)
        const bullCross = ema9Prev <= ema21Prev && ema9Curr > ema21Curr;
        const bearCross = ema9Prev >= ema21Prev && ema9Curr < ema21Curr;

        let signal = null;
        // LONG: cruzamento alta + RSI com fôlego pra subir (não sobrecomprado) + M15 Alta + Volume Alto
        if (bullCross && rsi > 30 && rsi < 60 && trend15m === 'UP' && isVolumeSpike) signal = 'LONG';
        // SHORT: cruzamento baixa + RSI com fôlego pra cair (não sobrevendido) + M15 Baixa + Volume Alto
        if (bearCross && rsi > 40 && rsi < 70 && trend15m === 'DOWN' && isVolumeSpike) signal = 'SHORT';

        const trend = ema9Curr > ema21Curr ? 'UP' : 'DOWN';
        const atrUSD = (1000 / currentPrice) * atrValue; // Balanço da volatilidade em dólares

        return {
            symbol, currentPrice, signal, trend, atrUSD,
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

                const atrBase = state.entryAtrUSD || 1.5; // Multiplicador base (1 ATR)
                let dynamicStopLoss = -(atrBase * 6); // Stop inicial: -6 ATR
                
                // Custo real da Binance ($1.00 taxa + $0.50 spread) = $1.50
                const feeOffset = 1.50;
                
                if (state.maxProfitUSD >= Math.max(atrBase * 5, 6.0)) {
                    dynamicStopLoss = Math.max(atrBase * 3, 4.0);  // TS: garante no mínimo +$4.00
                } else if (state.maxProfitUSD >= Math.max(atrBase * 3, 3.5)) {
                    dynamicStopLoss = feeOffset;  // BE: Breakeven cobrindo a taxa da Binance ($1.50)
                }

                const takeProfit = currentUSDResult >= (atrBase * 8); // Alvo final: +8 ATR
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



// ---- SCAN PARALELO (todos os símbolos ao mesmo tempo) ----
    try {
        const cooldownOk = !state.lastTradeTime || (Date.now() - state.lastTradeTime > 15000);
        
        const now = new Date();
        const day = now.getDay();
        const hour = now.getHours();
        // Trava de Fim de Semana: Sexta depois das 18h até Segunda às 08h
        const isWeekend = day === 0 || day === 6 || (day === 5 && hour >= 18) || (day === 1 && hour < 8);
        
        const results = await Promise.all(SYMBOLS.map(s => analyzeSymbol(s)));
        
        for (const result of results) {
            if (!result) continue;
            state.scannerData[result.symbol] = result;

            if (result.signal && !state.inPosition && cooldownOk && !isOpening && !isWeekend) {
                isOpening = true; // Trava imediata antes do await
                try {
                    await openTrade(result.symbol, result.signal, result.currentPrice, result.atrUSD);
                } finally {
                    isOpening = false;
                }
                break;
            }
        }
        saveState();
    } catch (e) {}
}

async function openTrade(symbol, side, price, atrUSD) {
    if (state.dailyProfitUSD >= 100.0) {
        log(`🏆 META DIÁRIA ATINGIDA ($ ${state.dailyProfitUSD.toFixed(2)}). Aguardando amanhã.`);
        return;
    }

    if (state.dailyProfitUSD <= -50.0) {
        log(`🚨 STOP DIÁRIO ATINGIDO ($ ${state.dailyProfitUSD.toFixed(2)}). Proteção da banca ativada. Aguardando amanhã.`);
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
        const rawAmount = 1000 / price; // Mão dobrada para garantir o alvo de lucro líquido
        const factor = Math.pow(10, precision);
        const amountStr = (Math.floor(rawAmount * factor) / factor).toFixed(precision);
        
        try { 
            await exchange.fapiPrivatePostLeverage({
                symbol: symbol.replace('/', ''),
                leverage: 5
            }); 
        } catch(e) {} // Ignora se a alavancagem já for 5x
        
        await exchange.fapiPrivatePostOrder({
            symbol: symbol.replace('/', ''),
            side: orderSide,
            type: 'MARKET',
            quantity: parseFloat(amountStr)
        });
        const finalAtrUSD = atrUSD || 1.5;
        const tpPercent = (finalAtrUSD * 8) / 1000;
        const slPercent = (finalAtrUSD * 6) / 1000;
        const tp = (side === 'LONG' ? price * (1 + tpPercent) : price * (1 - tpPercent)).toFixed(2);
        const sl = (side === 'LONG' ? price * (1 - slPercent) : price * (1 + slPercent)).toFixed(2);
        
        // --- ENVIA ORDEM DE STOP LOSS FÍSICO PARA A BINANCE ---
        const slPriceRaw = side === 'LONG' ? price * (1 - slPercent) : price * (1 + slPercent);
        const slPriceStr = exchange.priceToPrecision(symbol, slPriceRaw);
        const slOrderSide = side === 'LONG' ? 'SELL' : 'BUY';
        try {
            await exchange.fapiPrivatePostOrder({
                symbol: symbol.replace('/', ''),
                side: slOrderSide,
                type: 'STOP_MARKET',
                stopPrice: slPriceStr,
                closePosition: 'true'
            });
            log(`🛡️ STOP FÍSICO DE EMERGÊNCIA ARMADO EM: $${slPriceStr}`);
        } catch(e) {
            log(`⚠️ FALHA AO ARMAR STOP FÍSICO: ${e.message}`);
        }
        // ------------------------------------------------------

        const data = state.scannerData[symbol];
        log(`🎯 TRADE ABERTO: ${side} em ${symbol} | Entrada: $${price.toFixed(2)} | Alvo ATR: ~$${(finalAtrUSD*8).toFixed(2)}`);
        sendTelegram(`🔥 *NOVO TRADE ABERTO*\n\n➡️ Direção: ${side}\n💵 Preço: $${price.toFixed(2)}\n🎯 TP Esperado: $${tp}\n⚙️ Volatilidade ATR: $${finalAtrUSD.toFixed(2)}`);
        state.inPosition = true;
        state.entryPrice = price;
        state.activeSymbol = symbol;
        state.positionSide = side;
        state.maxProfitUSD = 0; // RESET TRAILING STOP TRACKER
        state.entryAtrUSD = finalAtrUSD; // Salva o ATR exato do momento da entrada
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

// Inicializa os mercados antes de começar o scanner
(async () => {
    try {
        log(`Carregando mercados da Binance...`);
        await exchange.loadMarkets();
        await publicExchange.loadMarkets();
        log(`Mercados carregados com sucesso.`);
    } catch(e) {
        log(`⚠️ Erro ao carregar mercados iniciais: ${e.message}`);
    }
    
    setInterval(runScanner, 5000); // 5s para evitar bloqueio de IP da Testnet
    runScanner();
})();
