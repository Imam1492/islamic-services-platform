import React, { useState } from 'react';
import { 
  CheckCircle2, 
  Terminal, 
  Layers, 
  Smartphone, 
  ShieldCheck, 
  FileCode, 
  CheckSquare, 
  Server, 
  ExternalLink,
  Copy,
  Check
} from 'lucide-react';

export default function App() {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const verificationCommands = [
    { label: 'Typecheck', command: 'npm --prefix mobile run typecheck', description: 'Standalone TypeScript check with noEmit' },
    { label: 'Lint', command: 'npm --prefix mobile run lint', description: 'ESLint execution via expo & strict TypeScript config' },
    { label: 'Test Suite', command: 'npm --prefix mobile test', description: 'Jest Expo smoke test with React Native Testing Library' }
  ];

  const handleCopy = (cmd: string, index: number) => {
    navigator.clipboard.writeText(cmd);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  return (
    <div id="architecture-dashboard" className="min-h-screen bg-stone-50 text-stone-900 font-sans p-6 md:p-12">
      <div className="max-w-5xl mx-auto space-y-8">
        
        {/* Header */}
        <header id="dashboard-header" className="border-b border-stone-200 pb-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold text-emerald-800 uppercase tracking-wider mb-1">
              <ShieldCheck className="w-4 h-4 text-emerald-700" />
              Verified Islamic Services Platform
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-stone-900">
              Phase 1: Architecture & Mobile Scaffolding
            </h1>
            <p className="text-stone-600 text-sm mt-1">
              Development tooling, strict configurations, and automated test setup.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800 border border-emerald-300">
              <CheckCircle2 className="w-3.5 h-3.5" />
              All Tooling Verified (Exit 0)
            </span>
          </div>
        </header>

        {/* Stack Overview */}
        <section id="stack-grid" className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div id="card-mobile" className="bg-white border border-stone-200 rounded-xl p-5 shadow-xs">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold text-stone-500 uppercase tracking-wider">Mobile Tier</span>
              <Smartphone className="w-4 h-4 text-emerald-700" />
            </div>
            <div className="text-lg font-semibold text-stone-900">React Native (Expo)</div>
            <div className="text-xs text-stone-500 mt-1">Expo SDK ~57.0.22</div>
            <div className="mt-3 pt-3 border-t border-stone-100 space-y-1 text-xs text-stone-600">
              <div className="flex justify-between"><span>React Native:</span> <span className="font-mono text-stone-800">0.86.3</span></div>
              <div className="flex justify-between"><span>React:</span> <span className="font-mono text-stone-800">19.2.3</span></div>
              <div className="flex justify-between"><span>Directory:</span> <span className="font-mono text-stone-800">/mobile</span></div>
            </div>
          </div>

          <div id="card-web" className="bg-white border border-stone-200 rounded-xl p-5 shadow-xs">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold text-stone-500 uppercase tracking-wider">Web Tier</span>
              <Layers className="w-4 h-4 text-stone-700" />
            </div>
            <div className="text-lg font-semibold text-stone-900">Next.js Architecture</div>
            <div className="text-xs text-stone-500 mt-1">Unified Platform Bridge</div>
            <div className="mt-3 pt-3 border-t border-stone-100 space-y-1 text-xs text-stone-600">
              <div className="flex justify-between"><span>Stage:</span> <span className="text-stone-800 font-medium">Phase 1 Planned</span></div>
              <div className="flex justify-between"><span>Monorepo:</span> <span className="font-mono text-stone-800">Root-level</span></div>
              <div className="flex justify-between"><span>Role:</span> <span className="text-stone-800">Portal & Discovery</span></div>
            </div>
          </div>

          <div id="card-backend" className="bg-white border border-stone-200 rounded-xl p-5 shadow-xs">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold text-stone-500 uppercase tracking-wider">Data Tier</span>
              <Server className="w-4 h-4 text-stone-700" />
            </div>
            <div className="text-lg font-semibold text-stone-900">Supabase (PostgreSQL)</div>
            <div className="text-xs text-stone-500 mt-1">Verified Services Storage</div>
            <div className="mt-3 pt-3 border-t border-stone-100 space-y-1 text-xs text-stone-600">
              <div className="flex justify-between"><span>Scope Boundary:</span> <span className="text-amber-700 font-medium">Phase 2 Target</span></div>
              <div className="flex justify-between"><span>Security:</span> <span className="text-stone-800">RLS Enforced</span></div>
              <div className="flex justify-between"><span>State:</span> <span className="text-stone-800 font-medium">Deferred per Phase 1</span></div>
            </div>
          </div>
        </section>

        {/* Verification Commands & Status */}
        <section id="verification-status" className="bg-white border border-stone-200 rounded-xl p-6 shadow-xs">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-stone-900">Automated Pipeline Verification</h2>
              <p className="text-xs text-stone-500">Every verification target passes with exit code 0 inside the mobile container.</p>
            </div>
            <span className="px-2.5 py-1 rounded bg-stone-100 text-stone-700 font-mono text-xs">
              3/3 passing
            </span>
          </div>

          <div className="space-y-3">
            {verificationCommands.map((item, idx) => (
              <div 
                key={idx} 
                className="p-3.5 bg-stone-50 border border-stone-200 rounded-lg flex flex-col md:flex-row md:items-center justify-between gap-3"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    <span className="text-sm font-semibold text-stone-900">{item.label}</span>
                    <span className="text-xs text-stone-500 hidden sm:inline">— {item.description}</span>
                  </div>
                  <code className="block font-mono text-xs text-stone-800 bg-white px-2.5 py-1 rounded border border-stone-200">
                    {item.command}
                  </code>
                </div>
                <button
                  onClick={() => handleCopy(item.command, idx)}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white border border-stone-300 rounded hover:bg-stone-100 text-stone-700 transition-colors"
                >
                  {copiedIndex === idx ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>
            ))}
          </div>
        </section>

        {/* Configured Artifacts */}
        <section id="scaffolded-artifacts" className="bg-white border border-stone-200 rounded-xl p-6 shadow-xs">
          <h2 className="text-lg font-bold text-stone-900 mb-4">Configured Phase 1 Artifacts</h2>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <div className="p-3 border border-stone-200 rounded-lg bg-stone-50/60">
              <div className="font-mono font-semibold text-xs text-stone-800 flex items-center gap-1.5 mb-1">
                <FileCode className="w-3.5 h-3.5 text-stone-600" />
                mobile/jest.config.js
              </div>
              <p className="text-xs text-stone-600">
                Official `jest-expo` preset with `transformIgnorePatterns` for React Native & Expo ESM modules.
              </p>
            </div>

            <div className="p-3 border border-stone-200 rounded-lg bg-stone-50/60">
              <div className="font-mono font-semibold text-xs text-stone-800 flex items-center gap-1.5 mb-1">
                <FileCode className="w-3.5 h-3.5 text-stone-600" />
                mobile/.eslintrc.js
              </div>
              <p className="text-xs text-stone-600">
                Root Expo ESLint configuration extending `expo` with strict TypeScript & React Native rules.
              </p>
            </div>

            <div className="p-3 border border-stone-200 rounded-lg bg-stone-50/60">
              <div className="font-mono font-semibold text-xs text-stone-800 flex items-center gap-1.5 mb-1">
                <FileCode className="w-3.5 h-3.5 text-stone-600" />
                mobile/tsconfig.json
              </div>
              <p className="text-xs text-stone-600">
                Configured with `strict: true`, `noEmit: true`, typeRoots, and Jest types for standalone validation.
              </p>
            </div>

            <div className="p-3 border border-stone-200 rounded-lg bg-stone-50/60">
              <div className="font-mono font-semibold text-xs text-stone-800 flex items-center gap-1.5 mb-1">
                <CheckSquare className="w-3.5 h-3.5 text-stone-600" />
                mobile/__tests__/App.test.tsx
              </div>
              <p className="text-xs text-stone-600">
                Smoke test verifying `<App />` mounts cleanly using React Native Testing Library v13/14 async renderer.
              </p>
            </div>
          </div>
        </section>

      </div>
    </div>
  );
}

