'use client';
import { useState } from 'react';
// This pulls from the folder you created
import { vocabData } from '../data/chinese_data'; 

export default function BilibiliLearner() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [activeClip, setActiveClip] = useState(null);

  const searchWord = () => {
    const found = vocabData[query] || [];
    setResults(found);
    if (found.length > 0) setActiveClip(found[0]);
  };

  return (
    <main className="max-w-3xl mx-auto p-6 text-slate-800">
      <h1 className="text-2xl font-bold mb-4 text-center">Chinese YouGlish (Bilibili)</h1>
      
      <div className="flex gap-2 mb-6">
        <input 
          className="flex-1 p-2 border rounded shadow-sm focus:ring-2 focus:ring-blue-500 outline-none"
          placeholder="Enter Chinese word (e.g., 你好)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && searchWord()}
        />
        <button onClick={searchWord} className="bg-red-600 text-white px-5 py-2 rounded font-bold hover:bg-red-700 transition">
          Search
        </button>
      </div>

      {activeClip && (
        <div className="bg-white rounded-lg shadow-lg overflow-hidden border mb-6">
          <div className="aspect-video">
            <iframe
              src={`//://bilibili.com{activeClip.bvid}&t=${activeClip.timestamp}&autoplay=1`}
              className="w-full h-full"
              allowFullScreen
            />
          </div>
          <div className="p-4 bg-slate-50 border-t text-center italic text-lg">
             "{activeClip.text}"
          </div>
        </div>
      )}

      <div className="space-y-3">
        {results.map((clip, index) => (
          <button 
            key={index}
            onClick={() => setActiveClip(clip)}
            className={`w-full text-left p-3 border rounded transition ${activeClip === clip ? 'border-red-500 bg-red-50' : 'hover:bg-gray-50'}`}
          >
            <p className="text-xs text-gray-500 uppercase tracking-wider">Example {index + 1}</p>
            <p className="font-medium text-slate-700">{clip.text}</p>
          </button>
        ))}
      </div>
    </main>
  );
}

