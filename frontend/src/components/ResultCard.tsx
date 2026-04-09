import React from 'react';
import { Package, PoundSterling, ExternalLink } from 'lucide-react';
import { motion } from 'framer-motion';

export interface ProductData {
  source: string;
  title: string;
  price: number;
  inStock: boolean;
}

interface ResultCardProps {
  product: ProductData;
  index: number;
  color?: 'cyan' | 'emerald';
}

export const ResultCard: React.FC<ResultCardProps> = ({ product, index, color = 'cyan' }) => {
  const accentColor = color === 'cyan' ? 'text-cyan-400' : 'text-emerald-400';
  const bgColor = color === 'cyan' ? 'bg-cyan-500/10' : 'bg-emerald-500/10';

  return (
    <motion.div
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.05, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className={`glass group relative px-8 py-5 flex items-center justify-between gap-8 mb-4 hover:bg-slate-900/40 transition-all duration-300 border-x-0 rounded-none first:rounded-t-2xl last:rounded-b-2xl first:border-t last:border-b border-white/5 hover:border-white/10`}
    >
      {/* Active Sidebar Indicator */}
      <div className={`absolute left-0 top-0 bottom-0 w-1 opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-b ${
        color === 'cyan' ? 'from-cyan-500 to-blue-600' : 'from-emerald-500 to-teal-600'
      }`}></div>

      <div className="flex items-center gap-6 flex-1 min-w-0">
        <div className={`p-3 rounded-xl ${bgColor} ${accentColor} border border-white/5 group-hover:scale-105 transition-transform duration-500 shadow-inner`}>
          <Package size={20} />
        </div>
        
        <div className="flex flex-col min-w-0">
          <h3 className="text-white text-lg font-bold truncate tracking-tight group-hover:text-cyan-400 transition-colors">
            {product.title}
          </h3>
          <div className="flex items-center gap-4 mt-1">
            <span className="text-[10px] font-black uppercase tracking-widest text-slate-500 flex items-center gap-1.5">
              Source: <span className={accentColor}>{product.source === 'myp-i-n' ? 'MYPIN GLOBAL' : 'TRIDENT NETWORK'}</span>
            </span>
            <div className="w-1 h-1 rounded-full bg-slate-800"></div>
            <span className="text-[10px] font-bold text-slate-600 uppercase tracking-wider">
              ID: {Math.random().toString(36).substr(2, 8).toUpperCase()}
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-12 shrink-0">
        {/* Availability Badge */}
        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-[0.1em] border border-white/5 shadow-sm ${
          product.inStock 
            ? 'bg-emerald-500/5 text-emerald-400 border-emerald-500/10' 
            : 'bg-red-500/5 text-red-400 border-red-500/10'
        }`}>
          <div className={`w-1.5 h-1.5 rounded-full ${product.inStock ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]'}`}></div>
          {product.inStock ? 'Available' : 'Out of Stock'}
        </div>

        {/* Pricing Column */}
        <div className="flex flex-col items-end min-w-[120px]">
          <span className="text-slate-500 text-[10px] font-black uppercase tracking-widest mb-1">Unit Price</span>
          <div className="flex items-center text-2xl font-black text-white leading-none tracking-tighter">
            <PoundSterling size={18} className="text-slate-500 mr-0.5" />
            {product.price.toFixed(2)}
          </div>
        </div>

        <button className={`w-12 h-12 rounded-xl border border-white/5 flex items-center justify-center text-slate-500 hover:text-white hover:bg-white/5 hover:border-white/10 transition-all active:scale-95`}>
          <ExternalLink size={20} strokeWidth={2.5} />
        </button>
      </div>
    </motion.div>
  );
};
