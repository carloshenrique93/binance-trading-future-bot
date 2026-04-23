import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { createChart } from 'lightweight-charts';
import { TrendingUp, Activity, DollarSign, List, Shield, Zap, Pause, Play, XCircle } from 'lucide-react';

const API_BASE = 'http://localhost:5000/api';

export default function App() {
  const [auth, setAuth] = useState(localStorage.getItem('bot_auth') || '');
  const [password, setPassword] = useState('');
  const [stats, setStats] = useState(null);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  
  const chartContainerRef = useRef();
  const chartRef = useRef();
  const candleSeriesRef = useRef();
  const entryLineRef = useRef();
  const tpLineRef = useRef();
  const slLineRef = useRef();
  const logsEndRef = useRef();

  const handleLogin = (e) => {
    e.preventDefault();
    const token = btoa(`admin:${password}`);
    localStorage.setItem('bot_auth', token);
    setAuth(token);
    setError('');
  };

  const fetchData = async () => {
    if (!auth) return;
    try {
      const config = { headers: { Authorization: `Basic ${auth}` } };
      const [statsRes, logsRes] = await Promise.all([
        axios.get(`${API_BASE}/stats`, config),
        axios.get(`${API_BASE}/logs`, config)
      ]);
      const data = statsRes.data;
      setStats(data);
      setLogs(logsRes.data);

      if (candleSeriesRef.current && data.priceHistory) {
          candleSeriesRef.current.setData(data.priceHistory);
          updateTradeLines(data);
      }
    } catch (err) {
      if (err.response?.status === 401) {
        setAuth('');
        localStorage.removeItem('bot_auth');
        setError('Senha incorreta!');
      }
    }
  };

  const updateTradeLines = (data) => {
    if (entryLineRef.current) { candleSeriesRef.current.removePriceLine(entryLineRef.current); entryLineRef.current = null; }
    if (tpLineRef.current) { candleSeriesRef.current.removePriceLine(tpLineRef.current); tpLineRef.current = null; }
    if (slLineRef.current) { candleSeriesRef.current.removePriceLine(slLineRef.current); slLineRef.current = null; }

    if (data.inPosition && data.entryPrice) {
        const isLong = data.direction === 'LONG';
        const entry = data.entryPrice;
        
        // Alvos atualizados para Nível 5: R$ 5,00 profit / R$ 5,00 stop
        // Com Banca 1000 e Posição 0.005 BTC (~$325 USD)
        // Ratio aprox: 5 BRL / (0.005 * BTC_Price * 5.4) 
        // Simplificando para aprox 0.003
        const tpPrice = isLong ? entry * 1.003 : entry * 0.997;
        const slPrice = isLong ? entry * 0.997 : entry * 1.003;

        entryLineRef.current = candleSeriesRef.current.createPriceLine({
            price: entry,
            color: '#3b82f6',
            lineWidth: 2,
            lineStyle: 0,
            axisLabelVisible: true,
            title: `ENTRADA ${data.direction}`,
        });

        tpLineRef.current = candleSeriesRef.current.createPriceLine({
            price: tpPrice,
            color: '#10b981',
            lineWidth: 2,
            lineStyle: 2,
            axisLabelVisible: true,
            title: 'ALVO LUCRO',
        });

        slLineRef.current = candleSeriesRef.current.createPriceLine({
            price: slPrice,
            color: '#ef4444',
            lineWidth: 2,
            lineStyle: 2,
            axisLabelVisible: true,
            title: 'STOP LOSS',
        });
    }
  };

  const togglePause = async () => {
    setLoading(true);
    try {
      const config = { headers: { Authorization: `Basic ${auth}` } };
      await axios.post(`${API_BASE}/toggle-pause`, {}, config);
      fetchData();
    } catch (err) { console.error(err); } finally { setLoading(false); }
  };

  const closePosition = async () => {
    if (!window.confirm('Deseja realmente fechar a posição agora?')) return;
    setLoading(true);
    try {
      const config = { headers: { Authorization: `Basic ${auth}` } };
      await axios.post(`${API_BASE}/close-position`, {}, config);
      fetchData();
    } catch (err) { console.error(err); } finally { setLoading(false); }
  };

  useEffect(() => {
    if (auth) {
      const interval = setInterval(fetchData, 2000);
      fetchData();
      return () => clearInterval(interval);
    }
  }, [auth]);

  useEffect(() => {
    if (logsEndRef.current) {
        logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  useEffect(() => {
    if (auth && chartContainerRef.current) {
        const chart = createChart(chartContainerRef.current, {
            layout: { background: { color: '#0c0c0c' }, textColor: '#d1d5db' },
            grid: { vertLines: { color: '#1f2937' }, horzLines: { color: '#1f2937' } },
            width: chartContainerRef.current.clientWidth,
            height: 400,
            timeScale: { timeVisible: true, secondsVisible: true, borderVisible: false },
            crosshair: { mode: 0 },
            priceScale: { autoScale: true, borderVisible: false },
            handleScale: { 
                axisPressedMouseMove: { price: true, time: true },
                mouseWheel: true,
                pinch: true
            },
            handleScroll: { 
                mouseWheel: true,
                pressedMouseMove: true,
                horzTouchDrag: true,
                vertTouchDrag: true 
            }
        });
        
        candleSeriesRef.current = chart.addCandlestickSeries({
            upColor: '#10b981',
            downColor: '#ef4444',
            borderVisible: false,
            wickUpColor: '#10b981',
            wickDownColor: '#ef4444',
        });

        chartRef.current = chart;

        const handleResize = () => {
            chart.applyOptions({ width: chartContainerRef.current.clientWidth });
        };
        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            chart.remove();
        };
    }
  }, [auth]);

  if (!auth) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0c0c0c] p-6 text-white font-sans">
        <div className="max-w-md w-full glass p-8 rounded-3xl space-y-6 shadow-[0_0_50px_rgba(59,130,246,0.15)]">
          <div className="flex justify-center"><Shield className="w-16 h-16 text-blue-500 animate-pulse" /></div>
          <div className="text-center">
            <h1 className="text-3xl font-bold tracking-tight">Robô Binance</h1>
            <p className="text-gray-400 text-sm mt-2">Nível 5: Quant-Master & Trend Filter</p>
          </div>
          <form onSubmit={handleLogin} className="space-y-4">
            <input 
              type="password" 
              className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 outline-none focus:ring-2 focus:ring-blue-500 transition-all text-center text-xl tracking-widest"
              placeholder="••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && <p className="text-red-500 text-xs text-center">{error}</p>}
            <button className="w-full bg-blue-600 font-bold p-4 rounded-2xl hover:bg-blue-500 transition-all shadow-lg shadow-blue-900/20 active:scale-95">DESBLOQUEAR ACESSO</button>
          </form>
        </div>
      </div>
    );
  }

  const currentBalance = 1000 + (stats?.dailyProfitBRL || 0);

  return (
    <div className="min-h-screen p-4 md:p-8 space-y-6 bg-[#0c0c0c] text-white font-sans selection:bg-blue-500/30">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="group">
          <h1 className="text-3xl font-black flex items-center gap-2 text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-cyan-300 to-blue-500 animate-gradient">
            <Zap className="w-8 h-8 text-yellow-400 fill-yellow-400" /> Scalper Nível 5
          </h1>
          <p className="text-gray-500 text-xs font-bold tracking-widest uppercase">Quant-Master: Tripla Confirmação Ativada</p>
        </div>
        <div className="flex gap-3">
            <button 
                onClick={togglePause}
                disabled={loading}
                className={`glass px-8 py-3 rounded-2xl text-xs font-black tracking-widest flex items-center gap-2 transition-all hover:scale-105 active:scale-95 ${stats?.isPaused ? 'bg-green-500/10 text-green-400 border-green-500/30' : 'bg-red-500/10 text-red-400 border-red-500/30'}`}
            >
                {stats?.isPaused ? <Play className="w-4 h-4 fill-current" /> : <Pause className="w-4 h-4 fill-current" />}
                {stats?.isPaused ? 'RETOMAR OPERAÇÕES' : 'PAUSAR ALGORITMO'}
            </button>
            <div className="glass px-6 py-3 rounded-2xl text-xs font-bold flex items-center gap-3 border-white/5 bg-white/5">
                <div className={`w-3 h-3 rounded-full ${stats?.isPaused ? 'bg-yellow-500 shadow-[0_0_10px_#eab308]' : 'bg-red-500 animate-ping shadow-[0_0_10px_#ef4444]'}`}></div> 
                <span className="opacity-80">{stats?.isPaused ? 'SISTEMA EM ESPERA' : 'MONITORAMENTO REALTIME'}</span>
            </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="glass p-6 rounded-3xl border-b-4 border-blue-500/50 bg-gradient-to-b from-white/5 to-transparent">
          <p className="text-gray-500 text-[10px] font-black uppercase mb-2 tracking-tighter">Banca Estimada (BRL)</p>
          <div className="flex items-center justify-between">
            <p className="text-3xl font-black tabular-nums">R$ {currentBalance.toFixed(2)}</p>
            <div className="p-2 bg-blue-500/20 rounded-xl"><DollarSign className="text-blue-400 w-5 h-5" /></div>
          </div>
        </div>
        <div className="glass p-6 rounded-3xl border-b-4 border-green-500/50 bg-gradient-to-b from-white/5 to-transparent">
          <p className="text-gray-500 text-[10px] font-black uppercase mb-2 tracking-tighter">Progresso do Dia</p>
          <div className="flex items-center justify-between">
            <p className={`text-3xl font-black tabular-nums ${stats?.dailyProfitBRL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              R$ {stats?.dailyProfitBRL?.toFixed(2) || '0.00'}
            </p>
            <div className="flex flex-col items-end">
                <span className="text-[10px] font-bold text-gray-400">Meta: R$ 10.00</span>
                <div className="p-1 bg-green-500/20 rounded-lg"><TrendingUp className="text-green-400 w-4 h-4" /></div>
            </div>
          </div>
        </div>
        <div className="glass p-6 rounded-3xl border-b-4 border-yellow-500/50 bg-gradient-to-b from-white/5 to-transparent">
          <p className="text-gray-500 text-[10px] font-black uppercase mb-2 tracking-tighter">Status Atual</p>
          <div className="flex items-center justify-between">
            <p className="text-xl font-black uppercase truncate mr-2">{stats?.inPosition ? `${stats.direction} @ ${stats.entryPrice?.toFixed(1)}` : 'Aguardando Sinal'}</p>
            <div className="p-2 bg-yellow-500/20 rounded-xl"><Activity className="text-yellow-400 w-5 h-5" /></div>
          </div>
        </div>
        <div className="flex flex-col gap-2">
            <button 
                onClick={closePosition}
                disabled={loading || !stats?.inPosition}
                className={`flex-1 rounded-3xl font-black text-xs flex items-center justify-center gap-2 transition-all shadow-lg ${stats?.inPosition ? 'bg-red-600 hover:bg-red-500 shadow-red-900/20 active:scale-95' : 'bg-white/5 text-gray-500 cursor-not-allowed border border-white/5'}`}
            >
                <XCircle className="w-5 h-5" /> FORÇAR FECHAMENTO
            </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 glass p-6 rounded-[2rem] relative overflow-hidden group">
          <div className="absolute top-6 right-8 z-10 flex items-center gap-2 bg-black/40 backdrop-blur-md px-3 py-1.5 rounded-full border border-white/10">
             <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse"></div>
             <span className="text-[10px] font-bold text-blue-100">BTC/USDT 1M CANDLES</span>
          </div>
          <h3 className="text-xs font-black mb-6 text-gray-500 uppercase tracking-[0.2em]">Fluxo de Preços & Execuções</h3>
          <div ref={chartContainerRef} className="w-full rounded-2xl overflow-hidden border border-white/5"></div>
        </div>
        <div className="glass p-8 rounded-[2rem] flex flex-col h-[500px] border border-white/5 shadow-inner">
          <h3 className="text-xs font-black mb-6 text-gray-500 uppercase tracking-[0.2em] flex items-center gap-2">
            <List className="w-4 h-4 text-blue-400" /> Histórico de Eventos
          </h3>
          <div className="flex-1 overflow-y-auto space-y-3 font-mono text-[10px] pr-2 custom-scrollbar">
            {logs.filter(log => !log.includes('──') && !log.includes('┌') && !log.includes('└')).map((log, i) => (
              <div key={i} className={`p-3 rounded-xl border-l-4 transition-all hover:bg-white/5 ${log.includes('🚀') ? 'border-blue-500 bg-blue-500/5' : log.includes('🏁') ? 'border-green-500 bg-green-500/5' : log.includes('❌') ? 'border-red-500 bg-red-500/5' : 'border-white/10 bg-white/5'}`}>
                {log}
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}
