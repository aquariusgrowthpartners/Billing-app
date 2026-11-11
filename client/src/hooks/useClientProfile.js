import { useCallback, useEffect, useState } from 'react';
import api from '../api.js';

/** Loads one client's profile (client + agreements + claims + totals). */
export function useClientProfile(clientId, { includeArchivedClaims = false, claimFrom = '', claimTo = '' } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(Boolean(clientId));
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    if (!clientId) {
      setData(null);
      setLoading(false);
      return null;
    }
    setLoading(true);
    try {
      const d = await api.getClient(clientId, {
        archived: includeArchivedClaims,
        from: claimFrom,
        to: claimTo,
      });
      setData(d);
      setError(null);
      return d;
    } catch (e) {
      setError(e.message);
      setData(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, [clientId, includeArchivedClaims, claimFrom, claimTo]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, loading, error, reload };
}

export default useClientProfile;
