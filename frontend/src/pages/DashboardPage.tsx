import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api';
import { Plus, FileText, Swords, GraduationCap, Calendar, Loader2 } from 'lucide-react';

interface Debate {
  id: string;
  title: string;
  description: string;
  mode: string;
  created_at: string;
}

export default function DashboardPage() {
  const navigate = useNavigate();

  // Form state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [persona, setPersona] = useState<'DEBATE' | 'COACH'>('DEBATE');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState('');

  // History state
  const [debates, setDebates] = useState<Debate[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);

  useEffect(() => {
    fetchDebates();
  }, []);

  const fetchDebates = async () => {
    try {
      const res = await api.get('/debates/');
      setDebates(res.data);
    } catch {
      // silent fail
    } finally {
      setLoadingHistory(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setFormError('Title is required');
      return;
    }
    if (!description.trim()) {
      setFormError('Description is required');
      return;
    }
    setFormError('');
    setCreating(true);
    try {
      const res = await api.post('/debates/', {
        title: title.trim(),
        description: description.trim(),
        mode: persona,
      });
      navigate(`/debate/${res.data.id}`);
    } catch (err: any) {
      setFormError(err.response?.data?.detail || 'Failed to create debate');
      setCreating(false);
    }
  };

  const formatDate = (iso: string) => {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  return (
    <div className="max-w-7xl mx-auto px-6 py-10">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight text-gray-100">Dashboard</h1>
        <p className="text-gray-400 mt-1">Start a new session or review past debates</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-8">
        {/* Left Column: New Session */}
        <div className="lg:col-span-2">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 sticky top-24">
            <h2 className="text-lg font-semibold text-gray-100 mb-5 flex items-center gap-2">
              <Plus className="w-5 h-5 text-red-400" />
              New Session
            </h2>

            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1.5">Title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Universal Basic Income"
                  className="w-full px-4 py-3 bg-gray-850 border border-gray-700 rounded-xl text-gray-100 placeholder-gray-500 focus:outline-none focus:border-red-500/50 focus:ring-1 focus:ring-red-500/25 transition-all"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1.5">Description</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Briefly describe your position or the topic..."
                  rows={3}
                  className="w-full px-4 py-3 bg-gray-850 border border-gray-700 rounded-xl text-gray-100 placeholder-gray-500 focus:outline-none focus:border-red-500/50 focus:ring-1 focus:ring-red-500/25 transition-all resize-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1.5">Persona</label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setPersona('DEBATE')}
                    className={`py-3 px-4 rounded-xl border flex items-center justify-center gap-2 text-sm font-medium transition-all cursor-pointer ${persona === 'DEBATE'
                      ? 'bg-red-500/15 border-red-500/40 text-red-400'
                      : 'bg-gray-850 border-gray-700 text-gray-400 hover:border-gray-600'
                      }`}
                  >
                    <Swords className="w-4 h-4" />
                    Debate
                  </button>
                  <button
                    type="button"
                    onClick={() => setPersona('COACH')}
                    className={`py-3 px-4 rounded-xl border flex items-center justify-center gap-2 text-sm font-medium transition-all cursor-pointer ${persona === 'COACH'
                      ? 'bg-orange-500/15 border-orange-500/40 text-orange-400'
                      : 'bg-gray-850 border-gray-700 text-gray-400 hover:border-gray-600'
                      }`}
                  >
                    <GraduationCap className="w-4 h-4" />
                    Coach
                  </button>
                </div>
              </div>

              {formError && (
                <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-4 py-3 rounded-xl">
                  {formError}
                </div>
              )}

              <button
                type="submit"
                disabled={creating}
                className="w-full py-3 px-4 bg-linear-to-r from-red-600 to-orange-600 hover:from-red-500 hover:to-orange-500 text-white font-semibold rounded-xl flex items-center justify-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-red-500/20 hover:shadow-red-500/40 cursor-pointer"
              >
                {creating ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <>
                    Start Debate
                    <Swords className="w-4.5 h-4.5" />
                  </>
                )}
              </button>
            </form>
          </div>
        </div>

        {/* Right Column: History */}
        <div className="lg:col-span-3">
          <h2 className="text-lg font-semibold text-gray-100 mb-5 flex items-center gap-2">
            <FileText className="w-5 h-5 text-orange-400" />
            Past Sessions
          </h2>

          {loadingHistory ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-6 h-6 animate-spin text-gray-500" />
            </div>
          ) : debates.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 rounded-2xl p-12 text-center">
              <div className="w-14 h-14 rounded-2xl bg-gray-800 flex items-center justify-center mx-auto mb-4">
                <FileText className="w-7 h-7 text-gray-600" />
              </div>
              <p className="text-gray-500 text-sm">No debates yet. Start your first session!</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {debates.map((debate) => (
                <div
                  key={debate.id}
                  className="bg-gray-900 border border-gray-800 rounded-2xl p-5 hover:border-gray-700 transition-all group"
                >
                  <div className="flex items-start justify-between mb-3">
                    <h3 className="font-semibold text-gray-200 line-clamp-1 flex-1">{debate.title}</h3>
                    <span
                      className={`ml-2 px-2.5 py-0.5 rounded-full text-xs font-medium shrink-0 ${debate.mode === 'DEBATE'
                        ? 'bg-red-500/15 text-red-400'
                        : 'bg-orange-500/15 text-orange-400'
                        }`}
                    >
                      {debate.mode}
                    </span>
                  </div>

                  {debate.description && (
                    <p className="text-sm text-gray-500 line-clamp-2 mb-3">{debate.description}</p>
                  )}

                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs text-gray-500">
                      <Calendar className="w-3.5 h-3.5" />
                      {formatDate(debate.created_at)}
                    </span>
                    <button
                      onClick={() => navigate(`/report/${debate.id}`)}
                      className="text-xs font-medium text-red-400 hover:text-red-300 transition-colors cursor-pointer"
                    >
                      View Report →
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
