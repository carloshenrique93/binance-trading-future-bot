import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { createChart } from 'lightweight-charts';
import { TrendingUp, Activity, DollarSign, List, Shield, Zap, Pause, Play, XCircle, Layers, Coins, BarChart3, Binary, Radar, Target, ArrowUpRight, ArrowDownRight, RefreshCw, Cpu, Globe, Landmark, Clock, AlertTriangle, Wifi, WifiOff, Pickaxe, TrendingDown } from 'lucide-react';

const API_BASE = 'http://localhost:5000/api';
const FUNDING_API = 'http://localhost:5001/api';
const FOREX_API = 'http://localhost:5002/api';

export default function App() {
  const [auth, setAuth] = useState(localStorage.getItem('bot_auth') || '');
  const [password, setPassword] = useState('');
  const [stats, setStats] = useState(null);
  const [logs, setLogs] = useState([]);
  const [fundingStats, setFundingStats] = useState(null);
  const [fundingLogs, setFundingLogs] = useState([]);
  const [forexStats, setForexStats] = useState(null);
  const [forexLogs, setForexLogs] = useState([]);
  const [activeTab, setActiveTab] = useState('scalping');
  const [lastTick, setLastTick] = useState(Date.now());
  const [connectionError, setConnectionError] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  
  const chartContainerRef = useRef();
  const candleSeriesRef = useRef();
  const entryLineRef = useRef();

  const handleLogin = (e) => {
    e.preventDefault();
    const token = btoa(`admin:${password}`);
    localStorage.setItem('bot_auth', token);
    setAuth(token);
  };

  const getFundingCountdown = () => {
      if (!fundingStats?.nextFundingTime) return '---';
      const now = Date.now();
      const diff = fundingStats.nextFundingTime - now;
      if (diff <= 0) return 'COLHENDO...';
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      return `${h}h ${m}m`;
  };

  const handleAction = async (bot, type) => {
    setActionLoading(true);
    const baseUrl = bot === 'scalper' ? API_BASE : bot === 'miner' ? FUNDING_API : FOREX_API;
    const endpoint = type === 'pause' ? '/toggle-pause' : '/emergency-exit';
    try {
        await axios.post(`${baseUrl}${endpoint}`, {}, { headers: { Authorization: `Basic ${auth}` } });
        fetchData();
    } catch (err) {
        alert("Erro ao executar comando: " + err.message);
    }
    setActionLoading(false);
  };

  const fetchData = async () => {
    if (!auth) return;
    try {
      const config = { headers: { Authorization: `Basic ${auth}` }, timeout: 3000 };
      const [statsRes, logsRes, fundStatsRes, fundLogsRes, forexStatsRes, forexLogsRes] = await Promise.allSettled([
        axios.get(`${API_BASE}/stats`, config),
        axios.get(`${API_BASE}/logs`, config),
        axios.get(`${FUNDING_API}/stats`, config),
        axios.get(`${FUNDING_API}/logs`, config),
        axios.get(`${FOREX_API}/stats`, config),
        axios.get(`${FOREX_API}/logs`, config)
      ]);

      if (statsRes.status === 'fulfilled') setStats(statsRes.value.data);
      if (logsRes.status === 'fulfilled') setLogs(logsRes.value.data);
      if (fundStatsRes.status === 'fulfilled') setFundingStats(fundStatsRes.value.data);
      if (fundLogsRes.status === 'fulfilled') setFundingLogs(fundLogsRes.value.data);
      
      if (forexStatsRes.status === 'fulfilled') {
          setForexStats(forexStatsRes.value.data);
          const symbols = ['XAUUSD', 'GOLD', 'XAUUSD.m'];
          let xauData = null;
          for(const s of symbols) { if(forexStatsRes.value.data.scannerData?.[s]?.priceHistory) { xauData = forexStatsRes.value.data.scannerData[s]; break; } }
          if (activeTab === 'forex' && candleSeriesRef.current && xauData?.priceHistory) candleSeriesRef.current.setData(xauData.priceHistory);
          setConnectionError(false);
      } else if (activeTab === 'forex') setConnectionError(true);
      
      if (forexLogsRes.status === 'fulfilled') setForexLogs(forexLogsRes.value.data);
      setLastTick(Date.now());
    } catch (err) {}
  };

  useEffect(() => {
    if (activeTab === 'scalping' && candleSeriesRef.current && stats?.scannerData?.[stats.activeSymbol || 'BTC/USDT']?.priceHistory) {
        candleSeriesRef.current.setData(stats.scannerData[stats.activeSymbol || 'BTC/USDT'].priceHistory);
        if (stats.inPosition) {
            if (entryLineRef.current) candleSeriesRef.current.removePriceLine(entryLineRef.current);
            entryLineRef.current = candleSeriesRef.current.createPriceLine({ price: stats.entryPrice, color: '#3b82f6', lineWidth: 2, title: 'ENTRY' });
        }
    }
  }, [stats, activeTab]);

  useEffect(() => {
    if (auth) {
      const interval = setInterval(fetchData, 2000);
      return () => clearInterval(interval);
    }
  }, [auth, activeTab]);

  useEffect(() => {
    if (auth && chartContainerRef.current) {
        const chart = createChart(chartContainerRef.current, {
            layout: { background: { color: 'transparent' }, textColor: '#9ca3af' },
            grid: { vertLines: { color: '#1f2937' }, horzLines: { color: '#1f2937' } },
            timeScale: { timeVisible: true, secondsVisible: true },
            width: chartContainerRef.current.clientWidth,
            height: 380,
        });
        candleSeriesRef.current = chart.addCandlestickSeries({ upColor: '#10b981', downColor: '#ef4444' });
        const handleResize = () => chart.applyOptions({ width: chartContainerRef.current.clientWidth });
        window.addEventListener('resize', handleResize);
        return () => { window.removeEventListener('resize', handleResize); chart.remove(); };
    }
  }, [auth, activeTab]);

  if (!auth) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0a0a0a] text-white p-6">
        <div className="max-w-md w-full bg-[#111] p-10 rounded-3xl border border-white/5 shadow-2xl">
          <h1 className="text-3xl font-bold tracking-tight text-center mb-8">ALPHA SCANNER HUB</h1>
          <form onSubmit={handleLogin} className="space-y-4">
            <input type="password" placeholder="PASSWORD" className="w-full bg-black border border-white/10 rounded-xl p-4 text-center text-xl outline-none focus:border-blue-500" value={password} onChange={(e) => setPassword(e.target.value)} />
            <button className="w-full bg-blue-600 hover:bg-blue-500 font-bold py-4 rounded-xl transition-all">ENTRAR</button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#080808] text-white font-sans p-4 md:p-6 lg:p-8 space-y-6">
      
      <header className="flex flex-col md:flex-row justify-between items-center gap-6 bg-[#111] p-6 rounded-2xl border border-white/5 shadow-xl">
        <div className="flex items-center gap-4">
            <div className="p-2 bg-blue-600/10 rounded-xl border border-blue-500/20"><Radar className="w-6 h-6 text-blue-500" /></div>
            <div>
                <h1 className="text-2xl font-black tracking-tighter">ALPHA SCANNER HUB <span className="text-blue-500 text-xs ml-2">V10.0</span></h1>
                <div className="flex items-center gap-2 mt-1">
                    <div className={`w-1.5 h-1.5 rounded-full animate-pulse ${Date.now() - lastTick < 4000 ? 'bg-green-500' : 'bg-red-500'}`}></div>
                    <p className="text-[9px] font-bold text-gray-600 uppercase tracking-widest">Command & Control Center</p>
                </div>
            </div>
        </div>

        <div className="flex items-center gap-2 bg-black/50 p-1.5 rounded-xl border border-white/5">
            <button onClick={() => setActiveTab('scalping')} className={`px-8 py-2.5 rounded-lg text-xs font-black tracking-widest transition-all ${activeTab === 'scalping' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:text-white'}`}>SCALPER</button>
            <button onClick={() => setActiveTab('funding')} className={`px-8 py-2.5 rounded-lg text-xs font-black tracking-widest transition-all ${activeTab === 'funding' ? 'bg-purple-600 text-white' : 'text-gray-500 hover:text-white'}`}>MINER</button>
            <button onClick={() => setActiveTab('forex')} className={`px-8 py-2.5 rounded-lg text-xs font-black tracking-widest transition-all ${activeTab === 'forex' ? 'bg-orange-600 text-white' : 'text-gray-500 hover:text-white'}`}>FOREX</button>
        </div>
      </header>

      {activeTab === 'scalping' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 animate-in fade-in duration-500">
            <div className="lg:col-span-8 space-y-6">
                <div className="flex justify-between items-center bg-[#111] p-4 rounded-2xl border border-white/5">
                    <div className="flex items-center gap-4">
                        <button disabled={actionLoading} onClick={() => handleAction('scalper', 'pause')} className={`p-3 rounded-xl transition-all ${stats?.paused ? 'bg-green-500/20 text-green-500' : 'bg-yellow-500/20 text-yellow-500'}`}>
                            {stats?.paused ? <Play className="w-5 h-5" /> : <Pause className="w-5 h-5" />}
                        </button>
                        <div><p className="text-[10px] font-black text-gray-500 uppercase">Status do Robô</p><p className="text-xs font-bold">{stats?.paused ? 'PAUSADO (SINAL OFF)' : 'ATIVO (SCANNING...)'}</p></div>
                    </div>
                    <button disabled={actionLoading || !stats?.inPosition} onClick={() => handleAction('scalper', 'exit')} className="flex items-center gap-2 bg-red-600 hover:bg-red-500 disabled:opacity-30 px-6 py-3 rounded-xl text-[10px] font-black transition-all">
                        <XCircle className="w-4 h-4" /> ENCERRAR OPERAÇÃO
                    </button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {['BTC/USDT', 'ETH/USDT', 'SOL/USDT'].map(sym => {
                        const data = stats?.scannerData?.[sym];
                        const zVal = Math.abs(data?.zScore || 0);
                        return (
                            <div key={sym} className={`bg-[#111] p-6 rounded-3xl border transition-all ${zVal > 2 ? 'border-blue-500/50 shadow-[0_0_20px_rgba(59,130,246,0.1)]' : 'border-white/5'}`}>
                                <div className="flex justify-between items-start mb-4">
                                    <div><h2 className="text-xl font-black tracking-tighter">{sym.split('/')[0]}</h2><p className="text-xs font-bold text-gray-500 mt-1">$ {data?.currentPrice?.toLocaleString()}</p></div>
                                    <div className={`px-2 py-0.5 rounded text-[8px] font-black ${data?.trend?.includes('UP') ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>{data?.trend}</div>
                                </div>
                                <div className="mt-8 space-y-2">
                                    <div className="flex justify-between text-[9px] font-black text-gray-500 uppercase"><span>Probabilidade (Z)</span><span>{data?.zScore?.toFixed(2)}</span></div>
                                    <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden"><div className={`h-full transition-all duration-1000 ${zVal > 2 ? 'bg-blue-500' : 'bg-blue-500/30'}`} style={{ width: `${Math.min(100, zVal * 40)}%` }}></div></div>
                                </div>
                            </div>
                        )
                    })}
                </div>
                <div className="bg-[#111] p-8 rounded-[2rem] border border-white/5"><div ref={chartContainerRef} className="w-full"></div></div>
            </div>
            <div className="lg:col-span-4 space-y-6">
                <div className="bg-[#111] p-8 rounded-3xl border border-white/5 bg-gradient-to-br from-blue-600/5 to-transparent">
                    <div>
                        <h4 className="text-gray-400 text-sm mb-1">Lucro do Dia (USD)</h4>
                        <div className={`text-2xl font-bold ${stats?.dailyProfitUSD >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                            $ {stats?.dailyProfitUSD?.toFixed(2) || '0.00'}
                        </div>
                    </div>
                </div>
                <div className="bg-[#111] p-8 rounded-3xl border border-white/5 h-[430px] flex flex-col">
                    <h3 className="text-xs font-black mb-6 text-gray-500 uppercase tracking-widest flex items-center gap-2"><List className="w-4 h-4 text-blue-500" /> Histórico Neural</h3>
                    <div className="flex-1 overflow-y-auto space-y-2 custom-scrollbar pr-2">{logs.slice(-30).map((l, i) => <div key={i} className="text-[10px] font-mono opacity-50 border-b border-white/5 pb-2">{l}</div>)}</div>
                </div>
            </div>
        </div>
      )}

      {activeTab === 'funding' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 animate-in fade-in duration-500">
            <div className="lg:col-span-8 space-y-6">
                <div className="flex justify-between items-center bg-[#111] p-4 rounded-2xl border border-white/5">
                    <div className="flex items-center gap-4">
                        <button disabled={actionLoading} onClick={() => handleAction('miner', 'pause')} className={`p-3 rounded-xl transition-all ${fundingStats?.paused ? 'bg-green-500/20 text-green-500' : 'bg-yellow-500/20 text-yellow-500'}`}>
                            {fundingStats?.paused ? <Play className="w-5 h-5" /> : <Pause className="w-5 h-5" />}
                        </button>
                        <div><p className="text-[10px] font-black text-gray-500 uppercase">Busca de Ativos</p><p className="text-xs font-bold">{fundingStats?.paused ? 'PAUSADA' : 'SCANNING OPPORTUNITIES...'}</p></div>
                    </div>
                    <button disabled={actionLoading || !fundingStats?.activeHedge} onClick={() => handleAction('miner', 'exit')} className="flex items-center gap-2 bg-red-600 hover:bg-red-500 disabled:opacity-30 px-6 py-3 rounded-xl text-[10px] font-black transition-all">
                        <XCircle className="w-4 h-4" /> DESMONTAR HEDGE (SPOT+FUT)
                    </button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-[#111] p-8 rounded-3xl border border-purple-500/20 relative overflow-hidden">
                        <Pickaxe className="absolute -right-4 -bottom-4 w-24 h-24 text-purple-600/10 rotate-12" />
                        <p className="text-[10px] font-black text-gray-500 uppercase mb-4 tracking-widest">Mining Asset: {fundingStats?.activeHedge?.symbol.split(':')[0] || 'WAITING...'}</p>
                        <h2 className="text-4xl font-black text-purple-400 uppercase tracking-tight">{fundingStats?.activeHedge ? 'Harvesting' : 'Scanning...'}</h2>
                        <div className="mt-6 flex items-center gap-4">
                            <div className="px-3 py-1 bg-purple-500/10 rounded-lg border border-purple-500/20 text-[10px] font-black text-purple-400">APY: {fundingStats?.activeHedge?.apy || '0.00'}%</div>
                            <div className="px-3 py-1 bg-purple-500/10 rounded-lg border border-purple-500/20 text-[10px] font-black text-purple-400">Rate: {fundingStats?.activeHedge?.rate ? (fundingStats.activeHedge.rate * 100).toFixed(4) : '0.0000'}%</div>
                        </div>
                    </div>
                    <div className="bg-[#111] p-8 rounded-3xl border border-purple-500/20 relative overflow-hidden">
                        <TrendingUp className="absolute -right-4 -bottom-4 w-24 h-24 text-green-600/10" />
                        <p className="text-[10px] font-black text-gray-500 uppercase mb-4 tracking-widest">Total Yield Coletado (Real-Time)</p>
                        <h2 className="text-4xl font-black text-green-400 tracking-tighter">$ {fundingStats?.activeHedge?.fundingCollected?.toFixed(4) || '0.0000'}</h2>
                        <div className="flex items-center gap-2 mt-4"><Clock className="w-3 h-3 text-gray-500" /><p className="text-[9px] text-gray-500 uppercase font-bold tracking-widest">Próxima Colheita: <span className="text-white font-black">{getFundingCountdown()}</span></p></div>
                    </div>
                </div>
            </div>
            <div className="lg:col-span-4 bg-[#111] p-8 rounded-3xl border border-white/5 flex flex-col h-[550px]">
                <h3 className="text-xs font-black mb-6 text-gray-500 uppercase tracking-widest flex items-center gap-2"><Layers className="w-4 h-4 text-purple-500" /> Registro de Atividades</h3>
                <div className="flex-1 overflow-y-auto space-y-2 custom-scrollbar">{fundingLogs.slice(-30).map((l, i) => <div key={i} className="text-[10px] font-mono opacity-50 border-b border-white/5 pb-2">{l}</div>)}</div>
            </div>
        </div>
      )}

      {activeTab === 'forex' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 animate-in fade-in duration-500">
            <div className="lg:col-span-8 space-y-6">
                <div className="flex justify-between items-center bg-[#111] p-4 rounded-2xl border border-white/5">
                    <div className="flex items-center gap-4">
                        <button disabled={actionLoading} onClick={() => handleAction('forex', 'pause')} className={`p-3 rounded-xl transition-all ${forexStats?.paused ? 'bg-green-500/20 text-green-500' : 'bg-yellow-500/20 text-yellow-500'}`}>
                            {forexStats?.paused ? <Play className="w-5 h-5" /> : <Pause className="w-5 h-5" />}
                        </button>
                        <div><p className="text-[10px] font-black text-gray-500 uppercase">Analista Forex</p><p className="text-xs font-bold">{forexStats?.paused ? 'PAUSADO' : 'MONITORANDO CÉDULAS...'}</p></div>
                    </div>
                    <button disabled={actionLoading} onClick={() => handleAction('forex', 'exit')} className="flex items-center gap-2 bg-red-600 hover:bg-red-500 px-6 py-3 rounded-xl text-[10px] font-black transition-all">
                        <XCircle className="w-4 h-4" /> ENCERRAR TODAS AS ORDENS (MT5)
                    </button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {['XAUUSD', 'EURUSD', 'GBPUSD'].map(sym => {
                        const data = forexStats?.scannerData?.[sym];
                        const zVal = Math.abs(data?.zScore || 0);
                        return (
                            <div key={sym} className={`bg-[#111] p-6 rounded-3xl border transition-all ${zVal > 2 ? 'border-orange-500/50 shadow-[0_0_20px_rgba(249,115,22,0.1)]' : 'border-orange-500/10 bg-orange-500/5'}`}>
                                <h2 className="text-xl font-black text-orange-400">{sym === 'XAUUSD' ? 'XAU/USD' : sym}</h2>
                                <p className="text-sm font-bold text-gray-400 mt-1">$ {data?.currentPrice?.toLocaleString() || '---'}</p>
                                <div className="mt-8 space-y-2">
                                    <div className="flex justify-between text-[9px] font-black text-gray-500 uppercase"><span>Probability</span><span>{data?.zScore?.toFixed(2) || '0.00'}</span></div>
                                    <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden"><div className="h-full bg-orange-500 transition-all duration-500" style={{ width: `${Math.min(100, zVal * 40)}%` }}></div></div>
                                </div>
                            </div>
                        )
                    })}
                </div>
                <div className="bg-[#111] p-8 rounded-[2rem] border border-white/5 relative overflow-hidden">
                    {(new Date().getDay() === 0 || new Date().getDay() === 6 || (new Date().getHours() >= 18 && new Date().getDay() === 5)) && (
                        <div className="absolute inset-0 z-50 bg-black/80 flex flex-col items-center justify-center text-center p-10 backdrop-blur-sm">
                            <Clock className="w-16 h-16 text-orange-500 mb-4 animate-bounce" />
                            <h2 className="text-3xl font-black tracking-tighter text-white">MERCADO FECHADO</h2>
                            <p className="text-gray-400 max-w-xs mt-2 text-sm font-bold uppercase tracking-widest">O Forex fecha aos fins de semana. Volta no Domingo às 18:00.</p>
                        </div>
                    )}
                    <div ref={chartContainerRef} className="w-full"></div>
                </div>
            </div>
            <div className="lg:col-span-4 space-y-6">
                <div className="bg-[#111] p-8 rounded-3xl border border-white/5 bg-gradient-to-br from-orange-600/5 to-transparent">
                    <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Portfolio Balance (USD)</p>
                    <h2 className="text-3xl font-black text-orange-400 mt-1">$ {forexStats?.balanceUSD?.toFixed(2) || '500.00'}</h2>
                </div>
                <div className="bg-[#111] p-8 rounded-3xl border border-white/5 h-[400px] flex flex-col">
                    <h3 className="text-xs font-black mb-6 text-gray-500 uppercase tracking-widest">Forex History</h3>
                    <div className="flex-1 overflow-y-auto space-y-2 custom-scrollbar">{forexLogs.slice(-20).map((log, i) => <div key={i} className="text-[10px] font-mono opacity-50 border-b border-white/5 pb-2">{log}</div>)}</div>
                </div>
            </div>
        </div>
      )}
      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #333; border-radius: 10px; }
      `}} />
    </div>
  );
}
