import React from 'react';
import { motion } from 'framer-motion';
import { ResultCard } from './ResultCard';
import type { ProductData } from './ResultCard';
import { AlertCircle, ChevronRight } from 'lucide-react';

interface SourceSectionProps {
  title: string;
  icon: React.ElementType;
  results: ProductData[];
  isLoading: boolean;
  error?: string;
  color: 'cyan' | 'emerald';
}

export const SourceSection: React.FC<SourceSectionProps> = ({ 
  title, 
  icon: Icon, 
  results, 
  error,
  color 
}) => {
  const accentColor = color === 'cyan' ? 'text-cyan-400' : 'text-emerald-400';
  const bgColor = color === 'cyan' ? 'bg-cyan-500/10' : 'bg-emerald-500/10';
  const borderColor = color === 'cyan' ? 'border-cyan-500/20' : 'border-emerald-500/20';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between border-b border-white/5 pb-4">
        <div className="flex items-center gap-3">
          <div className={`p-2.5 rounded-xl ${bgColor} ${accentColor}`}>
            <Icon size={24} />
          </div>
          <h2 className="text-2xl font-bold text-white tracking-tight">
            {title}
          </h2>
          <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-xs font-medium text-slate-400">
            {results.length} results found
          </div>
        </div>
        <button className="text-slate-500 hover:text-white transition-colors flex items-center gap-1 text-sm font-medium">
          View All <ChevronRight size={16} />
        </button>
      </div>

      {results.length > 0 ? (
        <div className="flex flex-col">
          {results.map((product, i) => (
            <ResultCard key={i} product={product} index={i} color={color} />
          ))}
        </div>
      ) : error ? (
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className={`relative overflow-hidden glass p-12 border-dashed border-2 border-amber-500/30 flex flex-col items-center justify-center text-center group`}
        >
          <div className="absolute inset-0 animate-shimmer opacity-20"></div>
          <div className="p-4 rounded-full bg-amber-500/15 text-amber-300 mb-4 relative z-10">
            <AlertCircle size={32} />
          </div>
          <h3 className="text-xl font-bold text-white mb-2 relative z-10">
            Supplier Access Failed
          </h3>
          <p className="text-amber-100/90 max-w-2xl relative z-10 break-words">
            {title} could not be queried: {error}
          </p>
        </motion.div>
      ) : (
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className={`relative overflow-hidden glass p-12 border-dashed border-2 ${borderColor} flex flex-col items-center justify-center text-center group`}
        >
          <div className="absolute inset-0 animate-shimmer opacity-30"></div>
          <div className={`p-4 rounded-full ${bgColor} ${accentColor} mb-4 relative z-10`}>
            <AlertCircle size={32} />
          </div>
          <h3 className="text-xl font-bold text-white mb-2 relative z-10">
            Product Not Found
          </h3>
          <p className="text-slate-400 max-w-xs relative z-10">
            Our agents couldn't find this item at {title}. 
            Check the search query or verify with the supplier.
          </p>
        </motion.div>
      )}
    </div>
  );
};
