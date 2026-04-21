import { useEffect, useMemo, useState } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Upload, Download, Wallet, LogOut, Shield, ShieldOff, HardDrive, Network } from 'lucide-react';
import { toast } from 'sonner';
import { p2pUploadService } from '@/services/p2pUploadService';
import { contractService } from '@/services/contractService';

// ... (rest of file unchanged until handlePayout)

const handlePayout = async () => {
  if (earningsUsd <= 0) {
    toast.error('No earnings available yet');
    return;
  }

  try {
    const txHash = await contractService.withdraw();
    toast.success(`Withdraw sent: ${txHash}`);
  } catch (error) {
    console.error(error);
    toast.error('Withdraw failed');
  }
};

// rest of file stays same
