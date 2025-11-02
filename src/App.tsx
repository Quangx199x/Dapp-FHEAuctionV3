import { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import './index.css';

// Contract configuration
const CONTRACT_ADDRESS = "0xf885102a2ac3ef23744defb89ce71ad2b458e0ab";
const SEPOLIA_CHAIN_ID = 11155111;

// Simplified ABI
const CONTRACT_ABI = [
  "function getAuctionInfo() view returns (uint256 round, uint256 endBlock, uint8 state, uint256 maxDeposit, address leadBidder, uint256 validBidders)",
  "function getEstimatedEndTime() view returns (uint256)",
  "function getBidderInfo(address) view returns (uint256 deposit, bool hasBidded, bool cancelled)",
  "function getRoundBidders() view returns (address[])",
  "function minBidDeposit() view returns (uint256)",
  "function pendingRefunds(address) view returns (uint256)",
  "function paused() view returns (bool)",
  "function owner() view returns (address)",
  "function beneficiary() view returns (address)",
  "function feeCollector() view returns (address)",
  "function totalCollectedFees() view returns (uint256)",
  "function bid(bytes32 encryptedBid, bytes inputProof, bytes32 publicKey, bytes signature) payable",
  "function cancelBid()",
  "function claimRefund()",
  "function requestFinalize()",
  "function pauseAuction()",
  "function unpauseAuction()",
  "function updateBeneficiary(address)",
  "function updateFeeCollector(address)",
  "function transferOwnership(address)",
  "function withdrawPlatformFees()",
];

// Type definitions
interface FheInstance {
  createEncryptedInput: (contractAddress: string, userAddress: string) => EncryptedInput;
  getPublicKey: () => string | Uint8Array | { publicKey?: Uint8Array; key?: string | Uint8Array };
}

interface EncryptedInput {
  add64: (value: bigint) => void;
  encrypt: () => Promise<EncryptedData>;
}

interface EncryptedData {
  handles: string[];
  inputProof: Uint8Array;
}

interface FheConfig {
  network: unknown;
  contractAddress: string;
  gatewayUrl: string;
}

interface FheModule {
  initSDK: () => Promise<void>;
  createInstance: (config: FheConfig) => Promise<FheInstance>;
  SepoliaConfig: Record<string, unknown>;
}

interface LogEntry {
  time: string;
  type: string;
  msg: string;
  txHash?: string;
}

function App() {
  const [activeTab, setActiveTab] = useState<'user' | 'owner'>('user');
  const [account, setAccount] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [fheInstance, setFheInstance] = useState<FheInstance | null>(null);
  const [fhePublicKey, setFhePublicKey] = useState<string>('');
  const [fheStatus, setFheStatus] = useState('Not initialized');
  const [contract, setContract] = useState<ethers.Contract | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const [auctionData, setAuctionData] = useState({
    round: 0,
    state: 'LOADING',
    validBidders: 0,
    maxBidders: 50,
    currentLeader: 'None',
    endBlock: 0,
    currentBlock: 0,
    timeRemaining: '00:00:00',
    progress: 0,
    minIncrement: '0.00000001',
    estimatedEndTime: '',
    maxDepositWei: BigInt(0),
  });

  const [bidderInfo, setBidderInfo] = useState({
    deposit: '0',
    hasBidded: false,
    cancelled: false,
  });

  const [pendingRefund, setPendingRefund] = useState('0');
  const [roundBidders, setRoundBidders] = useState<string[]>([]);
  const [contractOwner, setContractOwner] = useState('');
  const [isPaused, setIsPaused] = useState(false);
  const [beneficiaryAddr, setBeneficiaryAddr] = useState('');
  const [feeCollectorAddr, setFeeCollectorAddr] = useState('');
  const [totalFees, setTotalFees] = useState('0');
  const [decryptionStatus, setDecryptionStatus] = useState<'IDLE' | 'PROCESSING' | 'COMPLETED'>('IDLE');
  const [bidAmount, setBidAmount] = useState('');
  const [depositAmount, setDepositAmount] = useState('');
  const [newBeneficiary, setNewBeneficiary] = useState('');
  const [newFeeCollector, setNewFeeCollector] = useState('');
  const [newOwner, setNewOwner] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  const isOwner = account && contractOwner && account.toLowerCase() === contractOwner.toLowerCase();

  const addLog = (type: string, msg: string, txHash?: string) => {
    setLogs(prev => [{
      time: new Date().toLocaleTimeString(),
      type,
      msg,
      txHash
    }, ...prev].slice(0, 50));
  };

  const connectWallet = async () => {
    if (!window.ethereum) {
      addLog('error', 'Please install MetaMask');
      return;
    }

    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const accounts = await provider.send('eth_requestAccounts', []);
      const network = await provider.getNetwork();

      if (Number(network.chainId) !== SEPOLIA_CHAIN_ID) {
        addLog('error', 'Please switch to Sepolia network');
        try {
          await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: `0x${SEPOLIA_CHAIN_ID.toString(16)}` }],
          });
        } catch (switchError) {
          const error = switchError as Error;
          addLog('error', error.message || 'Failed to switch network');
          return;
        }
      }

      setAccount(accounts[0]);
      setIsConnected(true);
      
      const signer = await provider.getSigner();
      const contractInstance = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
      setContract(contractInstance);
      
      addLog('success', `Connected: ${accounts[0].slice(0, 6)}...${accounts[0].slice(-4)}`);
    } catch (error) {
      const err = error as Error;
      addLog('error', err.message);
    }
  };

  const initFHE = async () => {
    if (fheStatus === 'Ready' || fheStatus === 'Initializing...') return;
    try {
      setFheStatus('Initializing...');
      addLog('pending', 'Loading FHE SDK v0.2.0 from Zama CDN...');
      
      const FheSDKModule = await Promise.race([
        import('https://cdn.zama.ai/relayer-sdk-js/0.2.0/relayer-sdk-js.js'),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('SDK load timeout')), 30000)
        )
      ]) as FheModule;

      const { initSDK, createInstance, SepoliaConfig } = FheSDKModule;
      
      addLog('pending', 'Initializing WASM files...');
      await Promise.race([
        initSDK(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('SDK init timeout')), 30000)
        )
      ]);

      addLog('pending', 'Creating FHE instance...');
      const config: FheConfig = { 
        ...SepoliaConfig, 
        network: window.ethereum,
        contractAddress: CONTRACT_ADDRESS,
        gatewayUrl: 'https://gateway.sepolia.zama.ai/',
      };
      
      const instance = await Promise.race([
        createInstance(config),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Instance creation timeout')), 30000)
        )
      ]) as FheInstance;
      
      addLog('info', 'Extracting FHE public key...');
      const publicKey = instance.getPublicKey();
      let fullPublicKeyHex: string;
      
      if (typeof publicKey === 'string') {
        fullPublicKeyHex = publicKey.startsWith('0x') ? publicKey : '0x' + publicKey;
      } else if (publicKey instanceof Uint8Array) {
        fullPublicKeyHex = ethers.hexlify(publicKey);
      } else if (typeof publicKey === 'object' && 'publicKey' in publicKey && publicKey.publicKey instanceof Uint8Array) {
        fullPublicKeyHex = ethers.hexlify(publicKey.publicKey);
      } else if (typeof publicKey === 'object' && 'key' in publicKey && publicKey.key) {
        const keyValue = publicKey.key;
        fullPublicKeyHex = (typeof keyValue === 'string' && keyValue.startsWith('0x')) ? keyValue : ethers.hexlify(keyValue as Uint8Array);
      } else {
        throw new Error(`Invalid public key format: ${typeof publicKey}`);
      }
      
      const pkLength = (fullPublicKeyHex.length - 2) / 2;
      let publicKeyBytes32: string;
      
      if (pkLength <= 32) {
        publicKeyBytes32 = ethers.zeroPadValue(fullPublicKeyHex, 32);
      } else {
        publicKeyBytes32 = ethers.keccak256(fullPublicKeyHex);
      }
      
      setFheInstance(instance);
      setFhePublicKey(publicKeyBytes32);
      setFheStatus('Ready');
      addLog('success', `FHE SDK initialized successfully`);
      
    } catch (error) {
      const err = error as Error;
      setFheStatus('Failed');
      addLog('error', `FHE initialization failed: ${err.message}`);
    }
  };

  const fetchAuctionInfo = useCallback(async () => {
    if (!contract) return;

    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const [info, currentBlock, estimatedEnd, minDeposit] = await Promise.all([
        contract.getAuctionInfo(),
        provider.getBlockNumber(),
        contract.getEstimatedEndTime().catch(() => 0),
        contract.minBidDeposit().catch(() => BigInt(10000000))
      ]);
      
      const maxDepositWei = info.maxDeposit;
      const blocksRemaining = Math.max(0, Number(info.endBlock) - currentBlock);
      const secondsRemaining = blocksRemaining * 12;
      const hours = Math.floor(secondsRemaining / 3600);
      const minutes = Math.floor((secondsRemaining % 3600) / 60);
      const seconds = secondsRemaining % 60;
      
      let estimatedEndTimeStr = '';
      if (estimatedEnd > 0) {
        const endDate = new Date(Number(estimatedEnd) * 1000);
        estimatedEndTimeStr = endDate.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
      }
      
      const stateNames = ['ACTIVE', 'ENDED', 'FINALIZING', 'FINALIZED', 'EMERGENCY'];
      const totalBlocks = 7200;
      const progressPercent = Math.min(100, ((totalBlocks - blocksRemaining) / totalBlocks) * 100);
      
      setAuctionData({
        round: Number(info.round),
        state: stateNames[Number(info.state)] || 'UNKNOWN',
        validBidders: Number(info.validBidders),
        maxBidders: 50,
        currentLeader: info.leadBidder === ethers.ZeroAddress ? 'None' : info.leadBidder,
        endBlock: Number(info.endBlock),
        currentBlock: currentBlock,
        timeRemaining: `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`,
        progress: progressPercent,
        minIncrement: ethers.formatEther(minDeposit),
        estimatedEndTime: estimatedEndTimeStr,
        maxDepositWei: maxDepositWei,
      });

      const stateNum = Number(info.state);
      if (stateNum === 2) setDecryptionStatus('PROCESSING');
      else if (stateNum === 3) setDecryptionStatus('COMPLETED');
      else setDecryptionStatus('IDLE');

      if (account) {
        const bInfo = await contract.getBidderInfo(account);
        setBidderInfo({
          deposit: ethers.formatEther(bInfo.deposit),
          hasBidded: bInfo.hasBidded,
          cancelled: bInfo.cancelled,
        });
        const refund = await contract.pendingRefunds(account);
        setPendingRefund(ethers.formatEther(refund));
      }

      const bidders = await contract.getRoundBidders();
      setRoundBidders(bidders);

    } catch (error) {
      console.error('Error fetching auction info:', error);
      addLog('error', 'Failed to fetch auction data');
    }
  }, [contract, account]);

  const fetchOwnerInfo = useCallback(async () => {
    if (!contract) return;
    try {
      const [owner, paused, beneficiary, feeCollector, fees] = await Promise.all([
        contract.owner(),
        contract.paused(),
        contract.beneficiary(),
        contract.feeCollector(),
        contract.totalCollectedFees()
      ]);
      setContractOwner(owner);
      setIsPaused(paused);
      setBeneficiaryAddr(beneficiary);
      setFeeCollectorAddr(feeCollector);
      setTotalFees(ethers.formatEther(fees));
    } catch (error) {
      console.error('Error fetching owner info:', error);
    }
  }, [contract]);

  const handleSubmitBid = async () => {
    if (!contract || !fheInstance || !account || !bidAmount || !depositAmount || !fhePublicKey) {
      addLog('error', '❌ Missing requirements');
      return;
    }

    try {
      setIsSubmitting(true);
      addLog('info', '🧪 Submitting encrypted bid...');
      
      const bidValue = parseFloat(bidAmount);
      const depositWei = ethers.parseEther(depositAmount);
      
      const bidInGwei = Math.floor(bidValue * 1e9);
      const input = fheInstance.createEncryptedInput(CONTRACT_ADDRESS, account);
      input.add64(BigInt(bidInGwei));
      const encryptedData = await input.encrypt();
      
      const encryptedBidHandle = encryptedData.handles[0];
      const inputProofHex = ethers.hexlify(encryptedData.inputProof);
      
      const combinedData = ethers.concat([encryptedBidHandle, fhePublicKey]);
      const hashedKey = ethers.keccak256(combinedData);
      
      const domain = {
        name: 'FHEAuction',
        version: '3',
        chainId: SEPOLIA_CHAIN_ID,
        verifyingContract: CONTRACT_ADDRESS,
      };
      const types = { PublicKey: [{ name: 'key', type: 'bytes32' }] };
      const value = { key: hashedKey };
      
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const signature = await signer.signTypedData(domain, types, value);
      
      const tx = await contract.bid(
        encryptedBidHandle,
        inputProofHex,
        hashedKey,
        signature,
        { value: depositWei, gasLimit: BigInt(10000000) }
      );
      
      addLog('pending', `TX: ${tx.hash}`);
      await tx.wait();
      addLog('success', `✅ Bid submitted successfully!`, tx.hash);
      
      setBidAmount('');
      setDepositAmount('');
      fetchAuctionInfo();
      
    } catch (error) {
      const err = error as Error;
      addLog('error', `❌ Failed: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancelBid = async () => {
    if (!contract || !account) return;
    try {
      setIsSubmitting(true);
      addLog('pending', 'Cancelling bid...');
      const tx = await contract.cancelBid();
      await tx.wait();
      addLog('success', `Bid cancelled!`, tx.hash);
      fetchAuctionInfo();
    } catch (error) {
      const err = error as Error;
      addLog('error', err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClaimRefund = async () => {
    if (!contract || !account) return;
    try {
      setIsSubmitting(true);
      addLog('pending', 'Claiming refund...');
      const tx = await contract.claimRefund();
      await tx.wait();
      addLog('success', `Refund claimed!`, tx.hash);
      fetchAuctionInfo();
    } catch (error) {
      const err = error as Error;
      addLog('error', err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRequestFinalize = async () => {
    if (!contract) return;
    try {
      setIsSubmitting(true);
      addLog('pending', 'Requesting finalization...');
      const tx = await contract.requestFinalize({ gasLimit: BigInt(5000000) });
      await tx.wait();
      addLog('success', `Finalization requested!`, tx.hash);
      setDecryptionStatus('PROCESSING');
      fetchAuctionInfo();
    } catch (error) {
      const err = error as Error;
      addLog('error', err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePauseAuction = async () => {
    if (!contract || !isOwner) return;
    try {
      setIsSubmitting(true);
      const tx = await contract.pauseAuction();
      await tx.wait();
      addLog('success', `Auction paused!`, tx.hash);
      setIsPaused(true);
    } catch (error) {
      const err = error as Error;
      addLog('error', err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUnpauseAuction = async () => {
    if (!contract || !isOwner) return;
    try {
      setIsSubmitting(true);
      const tx = await contract.unpauseAuction();
      await tx.wait();
      addLog('success', `Auction unpaused!`, tx.hash);
      setIsPaused(false);
    } catch (error) {
      const err = error as Error;
      addLog('error', err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdateBeneficiary = async () => {
    if (!contract || !isOwner || !newBeneficiary) return;
    try {
      setIsSubmitting(true);
      const tx = await contract.updateBeneficiary(newBeneficiary);
      await tx.wait();
      addLog('success', `Beneficiary updated!`, tx.hash);
      setBeneficiaryAddr(newBeneficiary);
      setNewBeneficiary('');
    } catch (error) {
      const err = error as Error;
      addLog('error', err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdateFeeCollector = async () => {
    if (!contract || !isOwner || !newFeeCollector) return;
    try {
      setIsSubmitting(true);
      const tx = await contract.updateFeeCollector(newFeeCollector);
      await tx.wait();
      addLog('success', `Fee collector updated!`, tx.hash);
      setFeeCollectorAddr(newFeeCollector);
      setNewFeeCollector('');
    } catch (error) {
      const err = error as Error;
      addLog('error', err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleWithdrawFees = async () => {
    if (!contract || !isOwner) return;
    try {
      setIsSubmitting(true);
      const tx = await contract.withdrawPlatformFees();
      await tx.wait();
      addLog('success', `Fees withdrawn!`, tx.hash);
      setTotalFees('0');
    } catch (error) {
      const err = error as Error;
      addLog('error', err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleTransferOwnership = async () => {
    if (!contract || !isOwner || !newOwner) return;
    if (!window.confirm('Are you sure? This action is irreversible!')) return;
    try {
      setIsSubmitting(true);
      const tx = await contract.transferOwnership(newOwner);
      await tx.wait();
      addLog('success', `Ownership transferred!`, tx.hash);
      setContractOwner(newOwner);
      setNewOwner('');
    } catch (error) {
      const err = error as Error;
      addLog('error', err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    if (contract && isConnected) {
      fetchAuctionInfo();
      fetchOwnerInfo();
      const interval = setInterval(() => {
        fetchAuctionInfo();
        fetchOwnerInfo();
      }, 5000);
      return () => clearInterval(interval);
    }
  }, [contract, isConnected, fetchAuctionInfo, fetchOwnerInfo]);

  useEffect(() => {
    if (window.ethereum) {
      window.ethereum.on('accountsChanged', () => window.location.reload());
      window.ethereum.on('chainChanged', () => window.location.reload());
    }
  }, []);

  return (
    <div className="container">
      {/* Header */}
      <div className="header">
        <div className="header-left">
          <div className="title-large">FHE AUCTION</div>
          <div className="subtitle">[SYSTEM ONLINE] FHE AUCTION by ZAMA</div>
        </div>
        <div className="header-right">
          <div className="header-info-grid">
            <div className="header-stat">
              <span className="stat-label">CONTRACT:</span>
              <span className="stat-value-small">{CONTRACT_ADDRESS.slice(0, 6)}...{CONTRACT_ADDRESS.slice(-4)}</span>
            </div>
            <div className="header-stat">
              <span className="stat-label">NETWORK:</span>
              <span className="stat-value-small">SEPOLIA</span>
            </div>
            <div className="header-stat">
              <span className="stat-label">ROUND:</span>
              <span className="stat-value-small">#{auctionData.round}</span>
            </div>
          </div>
          {!isConnected && (
            <button className="btn btn-connect" onClick={connectWallet}>
              CONNECT WALLET
            </button>
          )}
        </div>
      </div>

      {/* Auction Status */}
      <div className="panel glow">
        <div className="panel-header">&gt; AUCTION STATUS</div>
        <div className="stats-grid">
          <div className="stat-box">
            <div className="stat-label">STATE</div>
            <div className={`stat-value status-${auctionData.state.toLowerCase()}`}>
              {auctionData.state}
            </div>
          </div>
          <div className="stat-box">
            <div className="stat-label">BIDDERS</div>
            <div className="stat-value">{auctionData.validBidders}/{auctionData.maxBidders}</div>
          </div>
          <div className="stat-box">
            <div className="stat-label">TIME LEFT</div>
            <div className="stat-value">{auctionData.timeRemaining}</div>
          </div>
          <div className="stat-box">
            <div className="stat-label">END BLOCK</div>
            <div className="stat-value">#{auctionData.endBlock}</div>
          </div>
        </div>

        <div className="info-grid-2col">
          <div className="info-row">
            <span className="info-label">[MINIMUM DEPOSIT INCREMENT]</span>
            <span className="info-value-inline">{auctionData.minIncrement} ETH</span>
          </div>
          <div className="info-row">
            <span className="info-label">[ESTIMATED END TIME]</span>
            <span className="info-value-inline">{auctionData.estimatedEndTime || 'Calculating...'}</span>
          </div>
          <div className="info-row">
            <span className="info-label">[CURRENT LEADER]</span>
            <span className="info-value-inline">
              {auctionData.currentLeader === 'None' ? 'NONE' : 
                `${auctionData.currentLeader.slice(0, 6)}...${auctionData.currentLeader.slice(-4)}`}
            </span>
          </div>
        </div>
      </div>

      {/* Tab Navigation */}
      {isConnected && (
        <div className="tab-nav">
          <button 
            className={`tab ${activeTab === 'user' ? 'active' : ''}`}
            onClick={() => setActiveTab('user')}
          >
            USER PANEL
          </button>
          {isOwner && (
            <button 
              className={`tab ${activeTab === 'owner' ? 'active' : ''} owner-tab`}
              onClick={() => setActiveTab('owner')}
            >
              OWNER PANEL
            </button>
          )}
        </div>
      )}

      {/* FHE Encryption Status */}
      {isConnected && (
        <div className="panel">
          <div className="panel-header">&gt; FHE ENCRYPTION STATUS</div>
          <div className="info-grid-2col">
            <div className="info-row">
              <span className="info-label">[FHE SDK STATUS]</span>
              <span className={`badge ${fheStatus === 'Ready' ? 'badge-active' : fheStatus === 'Failed' ? 'badge-ended' : ''}`}>
                {fheStatus.toUpperCase()}
              </span>
            </div>
            <div className="info-row">
              <span className="info-label">[FHE PUBLIC KEY]</span>
              <span className="info-value-inline">
                {fhePublicKey ? `${fhePublicKey.slice(0, 20)}...` : 'Not initialized'}
              </span>
            </div>
          </div>
          {fheStatus !== 'Ready' && (
            <button 
              className="btn" 
              onClick={initFHE} 
              disabled={fheStatus === 'Initializing...'}
            >
              {fheStatus === 'Initializing...' ? 'INITIALIZING...' : 'INITIALIZE FHE SDK'}
            </button>
          )}
        </div>
      )}

      {/* Main Content */}
      {activeTab === 'user' && isConnected ? (
        <div>
          {/* Place Bid */}
          {fheStatus === 'Ready' && auctionData.state === 'ACTIVE' && !bidderInfo.hasBidded && (
            <div className="panel glow">
              <div className="panel-header">&gt; &gt; PLACE ENCRYPTED BID</div>
              <div className="form-grid">
                <div className="form-group">
                  <label className="form-label">[BID AMOUNT (ETH)]</label>
                  <input 
                    className="input" 
                    type="number" 
                    step="0.000000001"
                    placeholder="0.001"
                    value={bidAmount}
                    onChange={(e) => setBidAmount(e.target.value)}
                    disabled={isSubmitting}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">[DEPOSIT AMOUNT (ETH)]</label>
                  <input 
                    className="input" 
                    type="number" 
                    step="0.01"
                    placeholder="Min: 0.00000001"
                    value={depositAmount}
                    onChange={(e) => setDepositAmount(e.target.value)}
                    disabled={isSubmitting}
                  />
                  <div className="form-hint">Min deposit: {auctionData.minIncrement} ETH</div>
                </div>
              </div>
              <button 
                className="btn btn-primary" 
                onClick={handleSubmitBid}
                disabled={!bidAmount || !depositAmount || isSubmitting}
              >
                {isSubmitting ? 'SUBMITTING...' : 'SUBMIT ENCRYPTED BID'}
              </button>
              <div className="control-note" style={{ borderColor: 'var(--green)', color: 'var(--green)' }}>
                [INFO] Your bid will be encrypted using FHE. Only the winner will be revealed after auction ends.
              </div>
            </div>
          )}

          {/* Your Bid Status */}
          <div className="panel">
            <div className="panel-header">&gt; YOUR BID STATUS</div>
            <div className="info-grid-2col">
              <div className="info-row">
                <span className="info-label">[YOUR DEPOSIT]</span>
                <span className="info-value-inline">{parseFloat(bidderInfo.deposit).toFixed(6)} ETH</span>
              </div>
              <div className="info-row">
                <span className="info-label">[BID STATUS]</span>
                <span className={`badge ${bidderInfo.hasBidded ? 'badge-encrypted' : ''}`}>
                  {bidderInfo.cancelled ? '❌ CANCELLED' : 
                   bidderInfo.hasBidded ? '🔒 PLACED' : 
                   '⚪ NO BID'}
                </span>
              </div>
              <div className="info-row">
                <span className="info-label">[PENDING REFUND]</span>
                <span className="info-value-inline">{parseFloat(pendingRefund).toFixed(6)} ETH</span>
              </div>
            </div>
            
            {/* Action Buttons */}
            {(bidderInfo.hasBidded || parseFloat(pendingRefund) > 0) && (
              <div className="button-grid">
                <button 
                  className="btn btn-red" 
                  onClick={handleCancelBid}
                  disabled={!bidderInfo.hasBidded || bidderInfo.cancelled || isSubmitting || auctionData.state !== 'ACTIVE'}
                >
                  CANCEL BID
                </button>
                <button 
                  className="btn" 
                  onClick={handleClaimRefund}
                  disabled={parseFloat(pendingRefund) === 0 || isSubmitting}
                >
                  CLAIM REFUND
                </button>
              </div>
            )}
          </div>

          {/* Finalization Panel - Show when auction ended */}
          {(auctionData.currentBlock >= auctionData.endBlock || auctionData.state === 'ENDED') && (
            <div className="panel glow">
              <div className="panel-header">&gt; &gt; FINALIZATION</div>
              <div className="info-row">
                <span className="info-label">[AUCTION STATUS]</span>
                <span className="badge badge-ended">AUCTION ENDED - READY TO FINALIZE</span>
              </div>
              <button 
                className="btn btn-primary" 
                onClick={handleRequestFinalize}
                disabled={decryptionStatus !== 'IDLE' || isSubmitting}
                style={{
                  borderColor: decryptionStatus === 'IDLE' ? 'var(--cyan)' : 'var(--green-dark)',
                  color: decryptionStatus === 'IDLE' ? 'var(--cyan)' : 'var(--green-dark)'
                }}
                title={decryptionStatus === 'IDLE' ? 'Click to request finalization and reveal winner' : 'Finalization already in progress'}
              >
                {isSubmitting ? 'REQUESTING...' : 'REQUEST FINALIZE'}
              </button>
              <div className="control-note" style={{ borderColor: 'var(--cyan)', color: 'var(--cyan)' }}>
                [INFO] Anyone can trigger finalization when auction ends. The winner will be revealed on-chain.
              </div>
            </div>
          )}

          {/* Round Bidders */}
          <div className="panel">
            <div className="panel-header">&gt; CURRENT ROUND BIDDERS [{roundBidders.length}]</div>
            {roundBidders.length === 0 ? (
              <div className="empty">[NO BIDDERS YET]</div>
            ) : (
              <div className="bidders-list">
                {roundBidders.map((bidder, i) => (
                  <div key={i} className="bidder-item">
                    <span>[{i + 1}] {bidder.slice(0, 6)}...{bidder.slice(-4)}</span>
                    {bidder.toLowerCase() === account.toLowerCase() && (
                      <span className="badge badge-encrypted">YOU</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : activeTab === 'owner' && isOwner ? (
        <div>
          {/* Auction Control Panel */}
          <div className="panel glow owner-control-panel">
            <div className="panel-header">&gt; &gt; AUCTION CONTROL PANEL</div>
            <div className="info-grid-2col">
              <div className="info-row">
                <span className="info-label">[OWNER ADDRESS]</span>
                <span className="info-value-inline">{contractOwner.slice(0, 10)}...{contractOwner.slice(-8)}</span>
              </div>
              <div className="info-row">
                <span className="info-label">[DECRYPTION STATUS]</span>
                <span className={`badge ${
                  decryptionStatus === 'IDLE' ? '' :
                  decryptionStatus === 'PROCESSING' ? 'badge-finalizing' :
                  'badge-finalized'
                }`}>
                  {decryptionStatus}
                </span>
              </div>
            </div>
            
            {/* Finalization Controls */}
            <div className="button-grid">
              <button 
                className="btn btn-finalize" 
                onClick={handleRequestFinalize}
                disabled={(auctionData.currentBlock < auctionData.endBlock && auctionData.state !== 'ENDED') || decryptionStatus !== 'IDLE' || isSubmitting}
                style={{
                  borderColor: ((auctionData.currentBlock >= auctionData.endBlock || auctionData.state === 'ENDED') && decryptionStatus === 'IDLE') ? 'var(--green)' : 'var(--green-dark)',
                  color: ((auctionData.currentBlock >= auctionData.endBlock || auctionData.state === 'ENDED') && decryptionStatus === 'IDLE') ? 'var(--green)' : 'var(--green-dark)'
                }}
                title={(auctionData.currentBlock >= auctionData.endBlock || auctionData.state === 'ENDED') && decryptionStatus === 'IDLE' ? 'Click to finalize auction' : 'Only available when auction time ends'}
              >
                REQUEST FINALIZE
              </button>
              <button 
                className="btn btn-red" 
                disabled={true}
                style={{ opacity: 0.3 }}
                title="Advanced feature - disabled in this version"
              >
                FORCE FINALIZE
              </button>
            </div>
            
            <div className="button-grid">
              <button 
                className="btn btn-red" 
                disabled={true}
                style={{ opacity: 0.3 }}
                title="Advanced feature - disabled in this version"
              >
                CANCEL DECRYPTION
              </button>
              <button 
                className="btn btn-red" 
                disabled={true}
                style={{ opacity: 0.3 }}
                title="Advanced feature - disabled in this version"
              >
                EMERGENCY END
              </button>
            </div>
            
            <div className="control-note">
              [NOTE] Advanced controls are disabled in this version. Only REQUEST FINALIZE is available when auction time ends.
            </div>
          </div>

          {/* Auction Status Control */}
          <div className="panel">
            <div className="panel-header">&gt; AUCTION STATUS CONTROL</div>
            <div className="info-row">
              <span className="info-label">[AUCTION STATUS]</span>
              <span className={isPaused ? 'badge badge-ended' : 'badge badge-active'}>
                {isPaused ? '⏸ PAUSED' : '▶ RUNNING'}
              </span>
            </div>
            <div className="button-grid">
              <button className="btn" onClick={handlePauseAuction} disabled={!isOwner || isPaused || isSubmitting}>
                PAUSE AUCTION
              </button>
              <button className="btn" onClick={handleUnpauseAuction} disabled={!isOwner || !isPaused || isSubmitting}>
                UNPAUSE AUCTION
              </button>
            </div>
          </div>

          {/* Configuration */}
          <div className="panel">
            <div className="panel-header">&gt; CONFIGURATION MANAGEMENT</div>
            <div className="info-row">
              <span className="info-label">[CURRENT BENEFICIARY]</span>
              <span className="info-value-inline">{beneficiaryAddr.slice(0, 10)}...{beneficiaryAddr.slice(-8)}</span>
            </div>
            <input 
              className="input" 
              placeholder="New Beneficiary Address (0x...)" 
              value={newBeneficiary} 
              onChange={(e) => setNewBeneficiary(e.target.value)} 
              disabled={isSubmitting}
            />
            <div className="info-row">
              <span className="info-label">[CURRENT FEE COLLECTOR]</span>
              <span className="info-value-inline">{feeCollectorAddr.slice(0, 10)}...{feeCollectorAddr.slice(-8)}</span>
            </div>
            <input 
              className="input" 
              placeholder="New Fee Collector Address (0x...)" 
              value={newFeeCollector} 
              onChange={(e) => setNewFeeCollector(e.target.value)} 
              disabled={isSubmitting}
            />
            <div className="button-grid">
              <button className="btn" onClick={handleUpdateBeneficiary} disabled={!newBeneficiary || isSubmitting}>
                UPDATE BENEFICIARY
              </button>
              <button className="btn" onClick={handleUpdateFeeCollector} disabled={!newFeeCollector || isSubmitting}>
                UPDATE FEE COLLECTOR
              </button>
            </div>
          </div>

          {/* Platform Fees */}
          <div className="panel">
            <div className="panel-header">&gt; PLATFORM FEE MANAGEMENT</div>
            <div className="info-grid-2col">
              <div className="info-row">
                <span className="info-label">[TOTAL COLLECTED FEES]</span>
                <span className="info-value-inline">{parseFloat(totalFees).toFixed(6)} ETH</span>
              </div>
              <div className="info-row">
                <span className="info-label">[FEE PERCENTAGE]</span>
                <span className="info-value-inline">2.5% (250 basis points)</span>
              </div>
            </div>
            <button className="btn" onClick={handleWithdrawFees} disabled={parseFloat(totalFees) === 0 || isSubmitting}>
              WITHDRAW PLATFORM FEES
            </button>
          </div>

          {/* Ownership */}
          <div className="panel">
            <div className="panel-header">&gt; OWNERSHIP MANAGEMENT</div>
            <input 
              className="input" 
              placeholder="New Owner Address (0x...)" 
              value={newOwner} 
              onChange={(e) => setNewOwner(e.target.value)} 
              disabled={isSubmitting}
            />
            <button className="btn btn-red" onClick={handleTransferOwnership} disabled={!newOwner || isSubmitting}>
              TRANSFER OWNERSHIP
            </button>
            <div className="warning">[WARNING] This action is IRREVERSIBLE!</div>
          </div>
        </div>
      ) : null}

      {/* Transaction Log */}
      <div className="panel">
        <div className="panel-header">&gt; &gt; LIVE TRANSACTION LOG</div>
        <div className="log">
          {logs.length === 0 ? (
            <div className="empty">[AWAITING TRANSACTIONS...]</div>
          ) : (
            logs.map((log, i) => (
              <div key={i} className="log-item">
                <span className="log-time">[{log.time}]</span>
                <span className={`log-type ${log.type}`}>{log.type.toUpperCase()}</span>
                <span className="log-msg">{log.msg}</span>
                {log.txHash && (
                  <a 
                    href={`https://sepolia.etherscan.io/tx/${log.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="log-link"
                  >
                    View →
                  </a>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="footer">
        <div>[SYSTEM STATUS: OPERATIONAL] • Auto-refresh: 5s</div>
        <div>
          Powered by{' '}
          <a 
            href="https://www.zama.ai/" 
            target="_blank" 
            rel="noopener noreferrer"
          >
            Zama FHE
          </a>
          {' '}| Network: Sepolia | Contract: {CONTRACT_ADDRESS.slice(0, 6)}...{CONTRACT_ADDRESS.slice(-4)}
        </div>
      </div>
    </div>
  );
}

export default App;