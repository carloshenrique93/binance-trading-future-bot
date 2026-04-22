import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { createChart } from 'lightweight-charts';
import { TrendingUp, Activity, DollarSign, List, Shield, Zap } from 'lucide-react';

const API_BASE = 'http://localhost:5000/api';

export default function App() {
  const [auth, setAuth] = useState(localStorage.getItem('bot_auth') || '');
  const [password, setPassword] = useState('');
  const [stats, setStats] = useState(null);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState('');
  const chartContainerRef = useRef();
  const lineSeriesRef = useRef();

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
      setStats(statsRes.data);
      setLogs(logsRes.data);

      if (lineSeriesRef.current && statsRes.data.priceHistory) {
          lineSeriesRef.current.setData(statsRes.data.priceHistory);
      }
    } catch (err) {
      if (err.response?.status === 401) {
        setAuth('');
        localStorage.removeItem('bot_auth');
        setError('Senha incorreta!');
      }
    }
  };

  useEffect(() => {
    if (auth) {
      const interval = setInterval(fetchData, 3000);
      fetchData();
      return () => clearInterval(interval);
    }
  }, [auth]);

  useEffect(() => {
    if (auth && chartContainerRef.current) {
        const chart = createChart(chartContainerRef.current, {
            layout: { background: { color: '#0c0c0c' }, textColor: '#d1d5db' },
            grid: { vertLines: { color: '#1f2937' }, horzLines: { color: '#1f2937' } },
            width: chartContainerRef.current.clientWidth,
            height: 300,
            timeScale: { timeVisible: true, secondsVisible: true }
        });
        lineSeriesRef.current = chart.addLineSeries({ 
            color: '#3b82f6',
            lineWidth: 2,
            priceFormat: { type: 'price', precision: 2, minMove: 0.01 }
        });

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
        <div className="max-w-md w-full glass p-8 rounded-3xl space-y-6">
          <div className="flex justify-center"><Shield className="w-12 h-12 text-blue-500" /></div>
          <div className="text-center">
            <h1 className="text-2xl font-bold">Acesso ao Robô</h1>
            <p className="text-gray-400 text-sm">Nível 3: Scalping Agressivo</p>
          </div>
          <form onSubmit={handleLogin} className="space-y-4">
            <input 
              type="password" 
              className="w-full bg-white/5 border border-white/10 rounded-xl p-4 outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Senha do Dashboard"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && <p className="text-red-500 text-xs">{error}</p>}
            <button className="w-full bg-blue-600 font-bold p-4 rounded-xl hover:bg-blue-500 transition-all">Acessar</button>
          </form>
        </div>
      </div>
    );
  }

  // DINAMIC BALANCE: 100 + PROFIT
  const currentBalance = 100 + (stats?.dailyProfitBRL || 0);

  return (
    <div className="min-h-screen p-4 md:p-8 space-y-6 bg-[#0c0c0c] text-white font-sans">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Zap className="w-8 h-8 text-yellow-400" /> Scalper Nível 3
          </h1>
          <p className="text-gray-400 text-sm">Frequência agressiva ativada</p>
        </div>
        <div className="glass px-4 py-2 rounded-full text-xs font-bold flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-red-500 animate-ping"></div> Live Monitoring
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="glass p-6 rounded-2xl border-l-4 border-blue-500">
          <p className="text-gray-400 text-xs uppercase mb-1">Banca Principal</p>
          <div className="flex items-center justify-between">
            <p className="text-2xl font-bold">R$ {currentBalance.toFixed(2)}</p>
            <DollarSign className="text-blue-500 w-5 h-5" />
          </div>
        </div>
        <div className="glass p-6 rounded-2xl border-l-4 border-green-500">
          <p className="text-gray-400 text-xs uppercase mb-1">Lucro Acumulado</p>
          <div className="flex items-center justify-between">
            <p className={`text-2xl font-bold ${stats?.dailyProfitBRL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              R$ {stats?.dailyProfitBRL?.toFixed(2) || '0.00'}
            </p>
            <TrendingUp className="text-green-500 w-5 h-5" />
          </div>
        </div>
        <div className="glass p-6 rounded-2xl border-l-4 border-yellow-500">
          <p className="text-gray-400 text-xs uppercase mb-1">Progresso Diário</p>
          <div className="flex items-center gap-3">
             <div className="flex-1 bg-white/5 h-2 rounded-full overflow-hidden">
               <div className="bg-yellow-500 h-full" style={{ width: `${Math.min((stats?.dailyProfitBRL || 0)*100, 100)}%` }}></div>
             </div>
             <span className="text-xs font-bold">{(stats?.dailyProfitBRL || 0).toFixed(2)} / 1.00</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 glass p-6 rounded-3xl">
          <h3 className="text-sm font-bold mb-4 opacity-70 uppercase tracking-widest">Fluxo de Preços Realtime</h3>
          <div ref={chartContainerRef} className="w-full rounded-xl overflow-hidden"></div>
        </div>
        <div className="glass p-6 rounded-3xl flex flex-col h-[350px]">
          <h3 className="text-sm font-bold mb-4 opacity-70 uppercase tracking-widest flex items-center gap-2">
            <List className="w-4 h-4 text-blue-400" /> Atividade do Robô
          </h3>
          <div className="flex-1 overflow-y-auto space-y-2 font-mono text-[10px]">
            {logs.map((log, i) => (
              <div key={i} className="p-2 border-l-2 border-blue-500/30 bg-white/5 rounded-r">
                {log}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
