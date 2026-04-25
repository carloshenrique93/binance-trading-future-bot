import MetaTrader5 as mt5
from flask import Flask, request, jsonify
import pandas as pd
from datetime import datetime

app = Flask(__name__)

# Configurações do MT5
MT5_LOGIN = 12345678  # Substituir pelo seu login real
MT5_PASSWORD = "your_password"
MT5_SERVER = "your_server"

def initialize_mt5():
    if not mt5.initialize():
        print("Falha ao iniciar MT5")
        return False
    return True

@app.route('/get_candles', methods=['GET'])
def get_candles():
    symbol = request.args.get('symbol', 'XAUUSD')
    count = int(request.args.get('count', 100))
    timeframe = mt5.TIMEFRAME_M1
    
    rates = mt5.copy_rates_from_pos(symbol, timeframe, 0, count)
    if rates is None:
        return jsonify({"error": "Símbolo não encontrado"}), 400
        
    df = pd.DataFrame(rates)
    df['time'] = df['time'].astype(int)
    return jsonify(df.to_dict('records'))

@app.route('/get_account', methods=['GET'])
def get_account():
    acc = mt5.account_info()
    if acc is None:
        return jsonify({"error": "Erro ao pegar conta"}), 500
    
    # Check trade_mode to detect if market is closed
    symbol_info = mt5.symbol_info("XAUUSD")
    trade_mode = symbol_info.trade_mode if symbol_info else 0
    
    return jsonify({
        "balance": acc.balance,
        "equity": acc.equity,
        "margin": acc.margin,
        "trade_mode": trade_mode, # 0 = Disabled, 4 = Full
        "connected": True
    })

@app.route('/close_all', methods=['POST'])
def close_all():
    symbol = request.json.get('symbol', 'XAUUSD')
    positions = mt5.positions_get(symbol=symbol)
    if positions is None:
        return jsonify({"success": True, "count": 0})
        
    closed_count = 0
    for pos in positions:
        tick = mt5.symbol_info_tick(symbol)
        type_dict = {mt5.ORDER_TYPE_BUY: mt5.ORDER_TYPE_SELL, mt5.ORDER_TYPE_SELL: mt5.ORDER_TYPE_BUY}
        price_dict = {mt5.ORDER_TYPE_BUY: tick.bid, mt5.ORDER_TYPE_SELL: tick.ask}
        
        request_close = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": symbol,
            "volume": pos.volume,
            "type": type_dict[pos.type],
            "position": pos.ticket,
            "price": price_dict[pos.type],
            "deviation": 20,
            "magic": 123456,
            "comment": "Alpha Exit",
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": mt5.ORDER_FILLING_IOC,
        }
        result = mt5.order_send(request_close)
        if result.retcode == mt5.TRADE_RETCODE_DONE:
            closed_count += 1
            
    return jsonify({"success": True, "count": closed_count})

if __name__ == '__main__':
    if initialize_mt5():
        app.run(port=5003)
