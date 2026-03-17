import { useEffect, useState, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import api from '../lib/api';
import ReactMarkdown from 'react-markdown';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { ArrowLeft, Loader2 } from 'lucide-react';

const METRIC_LABELS = ['Gaze', 'Posture', 'Shielding', 'Yaw', 'Soothing', 'Swaying', 'Tilt'];

interface ReportData {
  stats: number[];
  report: string;
}

export default function ReportPage() {
  const { debateId } = useParams<{ debateId: string }>();
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const triggeredRef = useRef(false);

  useEffect(() => {
    const fetchReport = async () => {
      try {
        const res = await api.get(`/debates/${debateId}/report`);
        setData(res.data);
        setLoading(false);
      } catch {
        // Report not found — trigger generation once
        if (!triggeredRef.current) {
          triggeredRef.current = true;
          setGenerating(true);
          setLoading(false);
          try {
            await api.post(`/debates/${debateId}/report`);
            // After generation, fetch the report
            const res = await api.get(`/debates/${debateId}/report`);
            setData(res.data);
            setGenerating(false);
          } catch {
            setGenerating(false);
            setError('Failed to generate report. Please try again later.');
          }
        } else {
          setLoading(false);
          setError('Report not found or not generated yet.');
        }
      }
    };
    fetchReport();
  }, [debateId]);

  if (loading || generating) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <Loader2 className="w-8 h-8 animate-spin text-red-400" />
        <p className="text-gray-400 text-sm">
          {generating ? 'Generating your report — this may take a moment...' : 'Loading report...'}
        </p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-10">
        <Link to="/dashboard" className="flex items-center gap-2 text-sm text-gray-400 hover:text-gray-300 mb-6">
          <ArrowLeft className="w-4 h-4" />
          Back to Dashboard
        </Link>
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-6 py-4 rounded-xl">
          {error || 'Failed to load report.'}
        </div>
      </div>
    );
  }

  const chartData = METRIC_LABELS.map((label, i) => ({
    name: label,
    value: Math.round(data.stats[i] * 10) / 10,
  }));

  const getBarColor = (value: number) => {
    if (value >= 80) return '#22c55e'; // green - great
    if (value >= 60) return '#eab308'; // yellow - okay
    if (value >= 40) return '#f97316'; // orange - concerning
    return '#ef4444'; // red - bad
  };

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      <Link to="/dashboard" className="flex items-center gap-2 text-sm text-gray-400 hover:text-gray-300 mb-8 transition-colors">
        <ArrowLeft className="w-4 h-4" />
        Back to Dashboard
      </Link>

      {/* Telemetry Chart */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-8">
        <h2 className="text-lg font-semibold text-gray-100 mb-6">Telemetry Performance</h2>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e1e2a" />
              <XAxis
                dataKey="name"
                tick={{ fill: '#7a7a96', fontSize: 12 }}
                axisLine={{ stroke: '#2a2a3a' }}
                tickLine={false}
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fill: '#7a7a96', fontSize: 12 }}
                axisLine={{ stroke: '#2a2a3a' }}
                tickLine={false}
                tickFormatter={(v) => `${v}%`}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#111118',
                  border: '1px solid #2a2a3a',
                  borderRadius: '12px',
                  color: '#ffffff',
                }}
                itemStyle={{ color: '#ffffff' }}
                labelStyle={{ color: '#7a7a96' }}
                formatter={(v) => [`${v}%`, 'Success Rate']}
              />
              <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                {chartData.map((entry, index) => (
                  <Cell key={index} fill={getBarColor(entry.value)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="flex items-center justify-center gap-6 mt-4 text-xs text-gray-500">
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-green-500 inline-block" /> 80–100%</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-yellow-500 inline-block" /> 60–79%</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-orange-500 inline-block" /> 40–59%</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-red-500 inline-block" /> 0–39%</span>
        </div>
      </div>

      {/* Markdown Report */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8">
        <div className="prose-invert max-w-none">
          <ReactMarkdown>{data.report}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
