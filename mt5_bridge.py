import MetaTrader5 as mt5
from flask import Flask, request, jsonify
import pandas as pd
from datetime import datetime, timezone

app = Flask(__name__)

@app.route('/ping', methods=['GET'])
def ping():
    info = mt5.account_info()
    return jsonify({"ok": True, "account": info.login if info else None})

def init():
    if not mt5.initialize():
        print("ERRO: Falha ao inicializar MT5")
        return False
    print(f"MT5 conectado | Conta: {mt5.account_info().login}")
    return True

# ─── VELAS ────────────────────────────────────────────────────────────────────
@app.route('/get_candles', methods=['GET'])
def get_candles():
    symbol = request.args.get('symbol', 'XAUUSD')
    count  = int(request.args.get('count', 40))
    rates  = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_M1, 0, count)
    if rates is None:
        return jsonify([])
    df = pd.DataFrame(rates)
    df['time'] = df['time'].astype(int)
    return jsonify(df[['time','open','high','low','close','tick_volume']].to_dict('records'))

# ─── CONTA ────────────────────────────────────────────────────────────────────
@app.route('/get_account', methods=['GET'])
def get_account():
    acc  = mt5.account_info()
    info = mt5.symbol_info('XAUUSD')
    if acc is None:
        return jsonify({"error": "MT5 desconectado"}), 500
    now = datetime.now(timezone.utc)
    # Forex fecha sex 22h UTC e abre dom 22h UTC
    is_weekend = (now.weekday() == 5) or (now.weekday() == 6 and now.hour < 22) or (now.weekday() == 4 and now.hour >= 22)
    return jsonify({
        "balance":    acc.balance,
        "equity":     acc.equity,
        "margin":     acc.margin,
        "profit":     acc.profit,
        "trade_mode": info.trade_mode if info else 0,
        "market_open": not is_weekend,
        "connected":  True
    })

# ─── POSIÇÕES ABERTAS ─────────────────────────────────────────────────────────
@app.route('/get_positions', methods=['GET'])
def get_positions():
    symbol    = request.args.get('symbol', None)
    positions = mt5.positions_get(symbol=symbol) if symbol else mt5.positions_get()
    if positions is None:
        return jsonify([])
    result = []
    for p in positions:
        result.append({
            "ticket":  p.ticket,
            "symbol":  p.symbol,
            "type":    "BUY" if p.type == mt5.ORDER_TYPE_BUY else "SELL",
            "volume":  p.volume,
            "price_open": p.price_open,
            "price_current": p.price_current,
            "profit":  p.profit,
            "sl":      p.sl,
            "tp":      p.tp
        })
    return jsonify(result)

# ─── ABRIR TRADE ──────────────────────────────────────────────────────────────
@app.route('/open_trade', methods=['POST'])
def open_trade():
    data   = request.json
    symbol = data.get('symbol', 'XAUUSD')
    side   = data.get('side', 'BUY').upper()   # BUY ou SELL
    volume = float(data.get('volume', 0.01))
    sl_pts = float(data.get('sl_points', 150))  # pontos de stop loss
    tp_pts = float(data.get('tp_points', 250))  # pontos de take profit

    tick = mt5.symbol_info_tick(symbol)
    info = mt5.symbol_info(symbol)
    if tick is None or info is None:
        return jsonify({"error": f"Símbolo {symbol} não encontrado"}), 400

    pt     = info.point
    digits = info.digits

    if side == 'BUY':
        price = tick.ask
        sl    = round(price - sl_pts * pt, digits)
        tp    = round(price + tp_pts * pt, digits)
        order_type = mt5.ORDER_TYPE_BUY
    else:
        price = tick.bid
        sl    = round(price + sl_pts * pt, digits)
        tp    = round(price - tp_pts * pt, digits)
        order_type = mt5.ORDER_TYPE_SELL

    req = {
        "action":      mt5.TRADE_ACTION_DEAL,
        "symbol":      symbol,
        "volume":      volume,
        "type":        order_type,
        "price":       price,
        "sl":          sl,
        "tp":          tp,
        "deviation":   50,
        "magic":       654321,
        "comment":     "Alpha Forex Scalper",
        "type_time":   mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_RETURN,  # Mais compatível com a maioria dos brokers
    }

    result = mt5.order_send(req)
    print(f"[MT5 ORDER] symbol={symbol} side={side} vol={volume} price={price} retcode={result.retcode} comment={result.comment}")
    
    if result.retcode == mt5.TRADE_RETCODE_DONE:
        return jsonify({
            "success": True,
            "ticket":  result.order,
            "price":   price,
            "sl":      sl,
            "tp":      tp
        })
    else:
        return jsonify({"success": False, "error": result.comment, "retcode": result.retcode}), 400

# ─── FECHAR TODAS AS ORDENS ───────────────────────────────────────────────────
@app.route('/close_all', methods=['POST'])
def close_all():
    symbol    = request.json.get('symbol', None)
    positions = mt5.positions_get(symbol=symbol) if symbol else mt5.positions_get()
    if not positions:
        return jsonify({"success": True, "count": 0, "profit": 0})

    total_profit = 0
    closed = 0
    for pos in positions:
        tick = mt5.symbol_info_tick(pos.symbol)
        req  = {
            "action":      mt5.TRADE_ACTION_DEAL,
            "symbol":      pos.symbol,
            "volume":      pos.volume,
            "type":        mt5.ORDER_TYPE_SELL if pos.type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY,
            "position":    pos.ticket,
            "price":       tick.bid if pos.type == mt5.ORDER_TYPE_BUY else tick.ask,
            "deviation":   30,
            "magic":       654321,
            "comment":     "Alpha Exit",
            "type_time":   mt5.ORDER_TIME_GTC,
            "type_filling": mt5.ORDER_FILLING_IOC,
        }
        result = mt5.order_send(req)
        if result.retcode == mt5.TRADE_RETCODE_DONE:
            total_profit += pos.profit
            closed += 1

    return jsonify({"success": True, "count": closed, "profit": round(total_profit, 2)})

# ─────────────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    if init():
        print("Bridge MT5 rodando na porta 5003...")
        app.run(port=5003, debug=False)
