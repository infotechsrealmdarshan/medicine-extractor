import React, { useState } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';

interface SearchBoxProps {
  onSearch: (query: string) => void;
  isLoading: boolean;
}

export const SearchBox: React.FC<SearchBoxProps> = ({ onSearch, isLoading }) => {
  const [query, setQuery] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim() && !isLoading) {
      onSearch(query.trim());
    }
  };

  return (
    <motion.form 
      onSubmit={handleSubmit}
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative w-full max-w-3xl mx-auto mb-16 z-20"
    >
      <div className="relative group">
        {/* Focus Glow Effect */}
        <div className="absolute -inset-1 bg-gradient-to-r from-cyan-500/20 to-blue-500/20 rounded-[28px] blur-xl opacity-0 group-focus-within:opacity-100 transition-opacity duration-500"></div>
        
        <div className="relative glass p-2 flex items-center shadow-2xl transition-all duration-500 focus-within:ring-1 focus-within:ring-cyan-500/30 group-focus-within:bg-slate-900/80">
          <div className="ml-5 text-slate-500 group-focus-within:text-cyan-400 transition-colors">
            <Search size={22} strokeWidth={2.5} />
          </div>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by PIP code, SKU, or Product Name..."
            className="w-full bg-transparent border-none outline-none text-xl px-6 py-4 placeholder:text-slate-600 font-medium tracking-tight text-white data-font"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading || !query.trim()}
            className={`mr-2 px-10 py-4 rounded-2xl font-black uppercase tracking-[0.1em] text-xs transition-all duration-300 relative overflow-hidden ${
              isLoading || !query.trim() 
                ? 'bg-slate-800 text-slate-600 cursor-not-allowed opacity-50' 
                : 'bg-white text-slate-950 hover:bg-cyan-400 hover:text-slate-950 active:scale-95 shadow-lg shadow-cyan-500/10'
            }`}
          >
            {isLoading ? (
              <div className="flex items-center gap-2">
                <Loader2 className="animate-spin" size={16} />
                <span>Processing</span>
              </div>
            ) : (
              'Initiate Scan'
            )}
          </button>
        </div>
      </div>
      
      <div className="mt-5 flex items-center justify-center gap-6">
        <span className="text-[10px] font-black text-slate-600 uppercase tracking-widest">Typical Queries:</span>
        <div className="flex gap-4">
          <button 
            type="button"
            className="text-[11px] font-bold text-slate-400 hover:text-cyan-400 transition-colors py-1 border-b border-transparent hover:border-cyan-400/30" 
            onClick={() => setQuery('Paracetamol')}
          >
            Paracetamol
          </button>
          <button 
            type="button"
            className="text-[11px] font-bold text-slate-400 hover:text-cyan-400 transition-colors py-1 border-b border-transparent hover:border-cyan-400/30" 
            onClick={() => setQuery('07090921')}
          >
            07090921
          </button>
          <button 
            type="button"
            className="text-[11px] font-bold text-slate-400 hover:text-cyan-400 transition-colors py-1 border-b border-transparent hover:border-cyan-400/30" 
            onClick={() => setQuery('4260873')}
          >
            4260873
          </button>
        </div>
      </div>
    </motion.form>
  );
};
