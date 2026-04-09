import React from 'react';
import { Loader2, ShieldCheck, Search, Database } from 'lucide-react';

interface LoadingStateProps {
  stage: 'login' | 'search' | 'extract' | 'idle';
}

const stages = [
  { id: 'login', icon: ShieldCheck, label: 'Authenticating with Supplier Portal...' },
  { id: 'search', icon: Search, label: 'Searching for Product Data...' },
  { id: 'extract', icon: Database, label: 'Extracting Pricing & Stock Details...' },
];

export const LoadingState: React.FC<LoadingStateProps> = ({ stage }) => {
  if (stage === 'idle') return null;

  return (
    <div className="flex flex-col items-center justify-center p-12 max-w-2xl mx-auto text-center space-y-12">
      <div className="relative w-full max-w-md h-48 glass overflow-hidden flex flex-col items-center justify-center border-white/10 group">
        {/* Animated Scanline */}
        <div className="absolute inset-0 animate-scan"></div>
        <div className="absolute inset-0 bg-gradient-to-t from-cyan-500/5 to-transparent"></div>
        
        <div className="relative z-10 flex flex-col items-center">
          <div className="p-4 rounded-2xl bg-cyan-500/10 text-cyan-400 mb-4 border border-cyan-500/20 shadow-lg shadow-cyan-500/10 scale-110">
            <Loader2 className="w-8 h-8 animate-spin" strokeWidth={3} />
          </div>
          <div className="space-y-1">
            <span className="text-[10px] font-black uppercase tracking-[0.3em] text-cyan-400/80">Extraction in Progress</span>
            <p className="text-white font-bold tracking-tight text-lg">Initializing Neural Scan...</p>
          </div>
        </div>

        {/* Decorative Corner Accents */}
        <div className="absolute top-4 left-4 w-4 h-4 border-t-2 border-l-2 border-cyan-500/30"></div>
        <div className="absolute top-4 right-4 w-4 h-4 border-t-2 border-r-2 border-cyan-500/30"></div>
        <div className="absolute bottom-4 left-4 w-4 h-4 border-b-2 border-l-2 border-cyan-500/30"></div>
        <div className="absolute bottom-4 right-4 w-4 h-4 border-b-2 border-r-2 border-cyan-500/30"></div>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full">
        {stages.map((s, i) => {
          const isActive = s.id === stage;
          const isDone = stages.findIndex(st => st.id === stage) > i;
          
          return (
            <div 
              key={s.id}
              className={`relative flex flex-col items-center gap-3 p-6 rounded-2xl transition-all duration-700 overflow-hidden ${
                isActive 
                  ? 'glass border-cyan-500/30 bg-slate-900/40 scale-100 shadow-xl' 
                  : isDone 
                    ? 'opacity-80 border-emerald-500/20' 
                    : 'opacity-30 grayscale'
              }`}
            >
              {isActive && (
                <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-transparent via-cyan-400 to-transparent"></div>
              )}
              
              <div className={`p-3 rounded-xl transition-all duration-500 ${
                isActive 
                  ? 'bg-cyan-500/20 text-cyan-300 ring-2 ring-cyan-500/20' 
                  : isDone 
                    ? 'bg-emerald-500/10 text-emerald-400' 
                    : 'bg-slate-800 text-slate-500'
              }`}>
                {isDone ? <ShieldCheck size={20} /> : <s.icon size={20} />}
              </div>
              
              <div className="flex flex-col">
                <span className={`text-[10px] font-black uppercase tracking-widest mb-1 ${
                  isActive ? 'text-cyan-400' : isDone ? 'text-emerald-400' : 'text-slate-500'
                }`}>
                  {isActive ? 'Scanning' : isDone ? 'Verified' : 'Pending'}
                </span>
                <span className={`text-xs font-bold leading-tight ${
                  isActive ? 'text-white' : 'text-slate-400'
                }`}>
                  {s.label}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
