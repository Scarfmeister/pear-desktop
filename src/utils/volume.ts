import { z } from 'zod';

// Shared by HTTP validation and external song controls (including MPRIS).
export const VolumePercentageSchema = z.number().min(0).max(100);
