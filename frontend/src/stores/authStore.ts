import { create } from 'zustand';
import api from '../lib/api';

interface AuthState {
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  signup: (name: string, email: string, password: string) => Promise<void>;
  logout: () => void;
  hydrate: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  isAuthenticated: false,
  isLoading: false,
  error: null,

  hydrate: () => {
    const token = localStorage.getItem('token');
    if (token) {
      set({ token, isAuthenticated: true });
    }
  },

  login: async (email: string, password: string) => {
    set({ isLoading: true, error: null });
    try {
      const res = await api.post('/auth/login', { email, password });
      const { access_token } = res.data;
      localStorage.setItem('token', access_token);
      set({ token: access_token, isAuthenticated: true, isLoading: false });
    } catch (err: any) {
      const message = err.response?.data?.detail || 'Login failed';
      set({ error: message, isLoading: false });
      throw new Error(message);
    }
  },

  signup: async (name: string, email: string, password: string) => {
    set({ isLoading: true, error: null });
    try {
      const res = await api.post('/auth/signup', { name, email, password });
      const { access_token } = res.data;
      localStorage.setItem('token', access_token);
      set({ token: access_token, isAuthenticated: true, isLoading: false });
    } catch (err: any) {
      const message = err.response?.data?.detail || 'Signup failed';
      set({ error: message, isLoading: false });
      throw new Error(message);
    }
  },

  logout: () => {
    localStorage.removeItem('token');
    set({ token: null, isAuthenticated: false });
    window.location.href = '/auth';
  },
}));
