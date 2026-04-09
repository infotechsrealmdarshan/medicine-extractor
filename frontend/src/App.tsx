import { useState } from 'react';
import axios from 'axios';
import { SearchBox } from './components/SearchBox';
import { SourceSection } from './components/SourceSection';
import type { ProductData } from './components/ResultCard';
import { LoadingState } from './components/LoadingState';
import { Search, Home, Moon, Layers, XCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

function App() {
  const [results, setResults] = useState<ProductData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [sourceFailures, setSourceFailures] = useState<Record<string, string>>({});
  const [stage, setStage] = useState<'login' | 'search' | 'extract' | 'idle'>('idle');
  const [searchPerformed, setSearchPerformed] = useState(false);

  const normalizeFailureMessage = (raw: string) => {
    const withoutAnsi = raw.replace(/\u001b\[[0-9;]*m/g, '');
    const firstLine = withoutAnsi.split('\n').find((line) => line.trim().length > 0) || withoutAnsi;
    return firstLine.trim();
  };

  const handleSearch = async (query: string) => {
    if (loading) return;
    setLoading(true);
    setResults([]);
    setError(null);
    setWarning(null);
    setSourceFailures({});
    setSearchPerformed(false);
    setStage('login');

    let loginTimer: number | undefined;
    let searchTimer: number | undefined;

    try {
      loginTimer = window.setTimeout(() => setStage('search'), 3000);
      searchTimer = window.setTimeout(() => setStage('extract'), 12000);

      // Use production URL if set, otherwise fallback to local proxy
      const backendUrl = import.meta.env.VITE_API_URL || '';
      const response = await axios.post(`${backendUrl}/api/search`, { query });

      if (response.data.success) {
        setResults(response.data.data);
        setSearchPerformed(true);

        const failures = response.data.meta?.failures || {};
        const normalizedFailures = Object.fromEntries(
          Object.entries(failures).map(([key, value]) => [key, normalizeFailureMessage(String(value))]),
        );

        setSourceFailures(normalizedFailures);

        if (normalizedFailures.trident) {
          setWarning(`Trident issue: ${normalizedFailures.trident}`);
        } else if (normalizedFailures['myp-i-n']) {
          setWarning(`MyPin issue: ${normalizedFailures['myp-i-n']}`);
        }
      } else {
        setError('Extraction failed. The supplier portal may be unavailable.');
      }
    } catch (err) {
      console.error(err);
      setError('Connection refused. Please ensure the backend scraper is running.');
    } finally {
      window.clearTimeout(loginTimer);
      window.clearTimeout(searchTimer);
      setLoading(false);
      setStage('idle');
    }
  };

  const myPinResults = results.filter(r => r.source === 'myp-i-n');
  const tridentResults = results.filter(r => r.source === 'trident');

  return (
    <div className="min-h-screen text-slate-200">
      {/* Premium Dashboard Header */}
      <nav className="fixed top-0 w-full z-50 glass border-t-0 rounded-t-none border-x-0 px-6 py-3 flex justify-between items-center backdrop-blur-3xl bg-slate-950/50">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-500/20">
              <Layers className="text-white" size={20} />
            </div>
            <div className="flex flex-col">
              <span className="text-lg font-black tracking-tight text-white leading-tight">
                PHOEBE <span className="text-cyan-400 font-medium">CORE</span>
              </span>
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em]">Inventory Intelligence</span>
            </div>
          </div>

          <div className="hidden md:flex items-center gap-2 ml-8 px-3 py-1.5 rounded-lg bg-white/5 border border-white/5">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></div>
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Engine: Active</span>
          </div>
        </div>

        <div className="flex items-center gap-8 text-slate-400 text-[11px] font-black uppercase tracking-[0.15em]">
          <a href="#" className="hover:text-cyan-400 transition-all flex items-center gap-2 group">
            <span className="opacity-60 group-hover:opacity-100 italic font-medium lowercase">v2.4.0</span>
            Terminal
          </a>
          <a href="#" className="hover:text-cyan-400 transition-all">Support</a>
          <div className="h-4 w-[1px] bg-white/10"></div>
          <button className="w-8 h-8 rounded-full border border-white/10 flex items-center justify-center hover:bg-white/5 transition-colors">
            <Home size={16} />
          </button>
        </div>
      </nav>

      <main className="container mx-auto px-6 pt-32 pb-20">
        {/* Dynamic Hero Section */}
        <div className="relative mb-24 py-12 text-center overflow-hidden">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[300px] bg-cyan-500/10 blur-[120px] rounded-full pointer-events-none"></div>

          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
            className="relative z-10"
          >
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-[10px] font-black text-cyan-400 uppercase tracking-[0.2em] mb-8">
              <Search size={12} /> Neural Extraction Engine
            </div>
            <h1 className="text-5xl md:text-8xl font-black tracking-tight mb-8 heading-premium">
              Intelligent <br className="hidden md:block" /> Extraction Hub
            </h1>
            <p className="text-slate-400 text-lg md:text-xl max-w-2xl mx-auto font-medium leading-relaxed">
              Precision procurement data for modern pharmacies.
              Real-time deep scanning across global supplier networks.
            </p>
          </motion.div>
        </div>

        <SearchBox onSearch={handleSearch} isLoading={loading} />

        <div className="mt-20 min-h-[500px]">
          {warning ? (
            <div className="mb-8 max-w-3xl mx-auto glass border-amber-500/30 bg-amber-500/10 px-5 py-4 text-amber-100">
              {warning}
            </div>
          ) : null}
          <AnimatePresence mode="wait">
            {loading ? (
              <motion.div
                key="loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="py-12"
              >
                <LoadingState stage={stage} />
              </motion.div>
            ) : error ? (
              <motion.div
                key="error"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-center space-y-4 glass p-12 max-w-lg mx-auto border-red-500/20"
              >
                <div className="text-red-400/20 inline-block p-6 rounded-full bg-red-400/5 mb-4">
                  <XCircle size={64} className="text-red-400/50" />
                </div>
                <h2 className="text-3xl font-bold text-white tracking-tight">{error}</h2>
                <p className="text-slate-500 text-lg">Try refining your search terms or verify the supplier status.</p>
              </motion.div>
            ) : searchPerformed ? (
              <motion.div
                key="results"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-20"
              >
                <SourceSection
                  title="MyPin (Supplier A)"
                  icon={Moon}
                  results={myPinResults}
                  isLoading={loading}
                  error={sourceFailures['myp-i-n']}
                  color="cyan"
                />
                <SourceSection
                  title="Trident (Supplier B)"
                  icon={Layers}
                  results={tridentResults}
                  isLoading={loading}
                  error={sourceFailures.trident}
                  color="emerald"
                />
              </motion.div>
            ) : (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-center space-y-8 py-20"
              >
                <div className="relative w-32 h-32 mx-auto mb-10">
                  <div className="absolute inset-0 bg-cyan-500/20 blur-[100px] rounded-full"></div>
                  <Search size={120} strokeWidth={1} className="text-slate-800 relative z-10" />
                </div>
                <div className="space-y-4">
                  <h3 className="text-3xl font-black text-slate-300">Ready to initiate query</h3>
                  <p className="text-slate-500 max-w-md mx-auto text-lg leading-relaxed">
                    Enter a PIP code or keyword to begin the deep-scan across all authorized supplier networks.
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      <footer className="border-t border-white/5 py-12 text-center text-slate-500 text-sm">
        <p>&copy; 2026 Medicing Extractor Pro. All rights reserved.</p>
        <div className="flex justify-center gap-4 mt-4">
          <a href="#" className="hover:text-cyan-400">Privacy Policy</a>
          <a href="#" className="hover:text-cyan-400">Terms of Service</a>
        </div>
      </footer>
    </div>
  );
}

export default App;
