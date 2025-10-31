import { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import './index.css';

// Contract configuration
const CONTRACT_ADDRESS = "0xf885102a2ac3ef23744defb89ce71ad2b458e0ab";
const SEPOLIA_CHAIN_ID = 11155111;

// Simplified ABI - only functions we need
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
  "event BidPlaced(address indexed bidder, uint256 indexed round, uint256 depositAmount, uint256 blockNumber, uint256 timestamp)",
  "event BidCancelled(address indexed bidder, uint256 indexed round, uint256 refundAmount, uint256 timestamp)",
  "event AuctionFinished(uint256 indexed round, address indexed winner, uint256 finalBid, uint256 platformFee, uint256 timestamp)",
  "event RefundClaimed(address indexed recipient, uint256 amount)"
];

function App() {
  // State management
  const [activeTab, setActiveTab] = useState<'user' | 'owner'>('user');
  const [account, setAccount] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [fheInstance, setFheInstance] = useState<any>(null);
  const [fheStatus, setFheStatus] = useState('Not initialized');
  const [contract, setContract] = useState<ethers.Contract | null>(null);
  const [logs, setLogs] = useState<any[]>([]);

  // Auction data state
  const [auctionData, setAuctionData] = useState({
    round: 0,
    state: 'LOADING',
    validBidders: 0,
    currentLeader: 'None',
    endBlock: 0,
    currentBlock: 0,
    timeRemaining: '00:00:00',
    progress: 0,
    minIncrement: '0.00000001',
    estimatedEndTime: '',
  });

  // User data state
  const [bidderInfo, setBidderInfo] = useState({
    deposit: '0',
    hasBidded: false,
    cancelled: false,
  });

  const [pendingRefund, setPendingRefund] = useState('0');
  const [roundBidders, setRoundBidders] = useState<string[]>([]);

  // Owner data state
  const [contractOwner, setContractOwner] = useState('');
  const [isPaused, setIsPaused] = useState(false);
  const [beneficiaryAddr, setBeneficiaryAddr] = useState('');
  const [feeCollectorAddr, setFeeCollectorAddr] = useState('');
  const [totalFees, setTotalFees] = useState('0');
  const [decryptionStatus, setDecryptionStatus] = useState<'IDLE' | 'PROCESSING' | 'COMPLETED'>('IDLE');

  // Form inputs
  const [bidAmount, setBidAmount] = useState('');
  const [depositAmount, setDepositAmount] = useState('');
  const [newBeneficiary, setNewBeneficiary] = useState('');
  const [newFeeCollector, setNewFeeCollector] = useState('');
  const [newOwner, setNewOwner] = useState('');

  // Loading states
  const [isSubmitting, setIsSubmitting] = useState(false);

  const addLog = (type: string, msg: string, txHash?: string) => {
    setLogs(prev => [{
      time: new Date().toLocaleTimeString(),
      type,
      msg,
      txHash
    }, ...prev].slice(0, 50));
  };

  // Connect wallet
  const connectWallet = async () => {
    try {
      if (!window.ethereum) {
        addLog('error', 'MetaMask not installed');
        return;
      }

      const accounts = await window.ethereum.request({
        method: 'eth_requestAccounts'
      });

      const chainId = await window.ethereum.request({ method: 'eth_chainId' });
      if (parseInt(chainId, 16) !== SEPOLIA_CHAIN_ID) {
        try {
          await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: `0x${SEPOLIA_CHAIN_ID.toString(16)}` }],
          });
        } catch (error: any) {
          addLog('error', 'Please switch to Sepolia network');
          return;
        }
      }

      setAccount(accounts[0]);
      setIsConnected(true);
      addLog('success', `Wallet connected: ${accounts[0].slice(0, 6)}...${accounts[0].slice(-4)}`);

      // Initialize contract
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      
      // Verify contract exists
      try {
        const code = await provider.getCode(CONTRACT_ADDRESS);
        if (code === '0x' || code === '0x0') {
          addLog('error', `Contract not found at ${CONTRACT_ADDRESS}. Please check contract address.`);
          return;
        }
      } catch (error: any) {
        addLog('error', 'Failed to verify contract existence');
        console.error(error);
      }
      
      const auctionContract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
      setContract(auctionContract);
      addLog('success', 'Contract initialized successfully');

      // Try to fetch initial data
      try {
        await auctionContract.getAuctionInfo();
        addLog('success', 'Contract connection verified');
      } catch (error: any) {
        addLog('error', `Contract call failed: ${error.message}. Check contract ABI or deployment.`);
        console.error('Contract verification error:', error);
      }

    } catch (error: any) {
      addLog('error', error.message || 'Failed to connect wallet');
    }
  };

  // Initialize FHE SDK
  const initFHE = async () => {
    try {
      setFheStatus('Initializing...');
      addLog('pending', 'Loading FHE SDK from Zama CDN...');
      
      // Import FHE SDK from CDN
      const FheSDKModule = await import(
        'https://cdn.zama.ai/relayer-sdk-js/0.2.0/relayer-sdk-js.js'
      );

      const { initSDK, createInstance, SepoliaConfig } = FheSDKModule;
      
      addLog('pending', 'Initializing WASM files...');
      await initSDK();

      addLog('pending', 'Creating FHE instance...');
      const config = { 
        ...SepoliaConfig, 
        network: window.ethereum,
        contractAddress: CONTRACT_ADDRESS,
      };
      
      const instance = await createInstance(config);
      setFheInstance(instance);
      setFheStatus('Ready');
      addLog('success', 'FHE SDK initialized successfully');
      
    } catch (error: any) {
      setFheStatus('Failed');
      addLog('error', `FHE initialization failed: ${error.message}`);
      console.error(error);
    }
  };

  // Fetch auction info - IMPROVED VERSION with better error handling
  const fetchAuctionInfo = useCallback(async () => {
    if (!contract) return;

    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      
      // Fetch basic info first
      let info, currentBlock, estimatedEnd, minDeposit;
      
      try {
        info = await contract.getAuctionInfo();
      } catch (error: any) {
        console.error('Error calling getAuctionInfo:', error);
        addLog('error', `Contract call failed: ${error.message || 'Unknown error'}`);
        return;
      }

      try {
        currentBlock = await provider.getBlockNumber();
      } catch (error: any) {
        console.error('Error getting block number:', error);
        currentBlock = 0;
      }

      try {
        estimatedEnd = await contract.getEstimatedEndTime();
      } catch (error: any) {
        console.error('Error getting estimated end time:', error);
        estimatedEnd = 0;
      }

      try {
        minDeposit = await contract.minBidDeposit();
      } catch (error: any) {
        console.error('Error getting min deposit:', error);
        minDeposit = BigInt(10000000); // 1 Gwei default
      }

      // Calculate time remaining based on blocks
      const blocksRemaining = Math.max(0, Number(info.endBlock) - currentBlock);
      const secondsRemaining = blocksRemaining * 12; // Sepolia block time ~12s
      
      const hours = Math.floor(secondsRemaining / 3600);
      const minutes = Math.floor((secondsRemaining % 3600) / 60);
      const seconds = secondsRemaining % 60;
      
      // Format estimated end time
      let estimatedEndTimeStr = '';
      if (estimatedEnd > 0) {
        const endDate = new Date(Number(estimatedEnd) * 1000);
        estimatedEndTimeStr = endDate.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
      }
      
      const stateNames = ['ACTIVE', 'ENDED', 'FINALIZING', 'FINALIZED', 'EMERGENCY'];
      
      // Calculate progress (assuming 7200 blocks = 24 hours)
      const totalBlocks = 7200;
      const progressPercent = Math.min(100, ((totalBlocks - blocksRemaining) / totalBlocks) * 100);
      
      setAuctionData({
        round: Number(info.round),
        state: stateNames[Number(info.state)] || 'UNKNOWN',
        validBidders: Number(info.validBidders),
        currentLeader: info.leadBidder === ethers.ZeroAddress ? 'None' : info.leadBidder,
        endBlock: Number(info.endBlock),
        currentBlock: currentBlock,
        timeRemaining: `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`,
        progress: progressPercent,
        minIncrement: ethers.formatEther(minDeposit) + ' ETH',
        estimatedEndTime: estimatedEndTimeStr,
      });

      // Update decryption status based on auction state
      const stateNum = Number(info.state);
      if (stateNum === 2) { // FINALIZING
        setDecryptionStatus('PROCESSING');
      } else if (stateNum === 3) { // FINALIZED
        setDecryptionStatus('COMPLETED');
      } else {
        setDecryptionStatus('IDLE');
      }

      // Fetch bidder info if connected
      if (account) {
        try {
          const bInfo = await contract.getBidderInfo(account);
          setBidderInfo({
            deposit: ethers.formatEther(bInfo.deposit),
            hasBidded: bInfo.hasBidded,
            cancelled: bInfo.cancelled,
          });

          const refund = await contract.pendingRefunds(account);
          setPendingRefund(ethers.formatEther(refund));
        } catch (error: any) {
          console.error('Error fetching bidder info:', error);
          // Don't show error for this, it's not critical
        }
      }

      // Fetch round bidders
      try {
        const bidders = await contract.getRoundBidders();
        setRoundBidders(bidders);
      } catch (error: any) {
        console.error('Error fetching round bidders:', error);
        setRoundBidders([]);
      }

    } catch (error: any) {
      console.error('Error fetching auction info:', error);
      addLog('error', `Failed to fetch data: ${error.message || 'Check contract address and network'}`);
    }
  }, [contract, account]);

  // Fetch owner info
  const fetchOwnerInfo = useCallback(async () => {
    if (!contract) return;

    try {
      const owner = await contract.owner();
      const paused = await contract.paused();
      const beneficiary = await contract.beneficiary();
      const feeCollector = await contract.feeCollector();
      const fees = await contract.totalCollectedFees();

      setContractOwner(owner);
      setIsPaused(paused);
      setBeneficiaryAddr(beneficiary);
      setFeeCollectorAddr(feeCollector);
      setTotalFees(ethers.formatEther(fees));
    } catch (error: any) {
      console.error('Error fetching owner info:', error);
    }
  }, [contract]);

  // Submit encrypted bid
  const handleSubmitBid = async () => {
    if (!contract || !fheInstance || !account || !bidAmount || !depositAmount) {
      addLog('error', 'Please fill all fields and initialize FHE SDK');
      return;
    }

    try {
      setIsSubmitting(true);
      addLog('pending', `Encrypting bid: ${bidAmount} ETH...`);

      // Convert bid to Gwei
      const bidInGwei = Math.floor(parseFloat(bidAmount) * 1e9);
      
      // Create encrypted input
      const input = fheInstance.createEncryptedInput(CONTRACT_ADDRESS, account);
      input.add64(BigInt(bidInGwei));
      const encryptedData = await input.encrypt();

      addLog('pending', 'Generating EIP-712 signature...');

      // Generate EIP-712 signature
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      const domain = {
        name: 'FHEAuction',
        version: '3',
        chainId: SEPOLIA_CHAIN_ID,
        verifyingContract: CONTRACT_ADDRESS,
      };

      const types = {
        PublicKey: [{ name: 'key', type: 'bytes32' }],
      };

      const value = {
        key: encryptedData.handles[0],
      };

      const signature = await signer.signTypedData(domain, types, value);

      addLog('pending', 'Submitting encrypted bid to blockchain...');

      // Submit bid
      const tx = await contract.bid(
        encryptedData.handles[0],
        encryptedData.inputProof,
        encryptedData.handles[0],
        signature,
        { value: ethers.parseEther(depositAmount) }
      );

      addLog('pending', `Transaction submitted: ${tx.hash}`);
      const receipt = await tx.wait();
      addLog('success', `Bid placed successfully! Block: ${receipt.blockNumber}`, tx.hash);
      
      // Clear form
      setBidAmount('');
      setDepositAmount('');
      
      // Refresh data
      fetchAuctionInfo();

    } catch (error: any) {
      addLog('error', error.message || 'Failed to submit bid');
      console.error(error);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Cancel bid
  const handleCancelBid = async () => {
    if (!contract) return;

    try {
      addLog('pending', 'Cancelling bid...');
      const tx = await contract.cancelBid();
      addLog('pending', `Transaction: ${tx.hash}`);
      await tx.wait();
      addLog('success', 'Bid cancelled successfully', tx.hash);
      fetchAuctionInfo();
    } catch (error: any) {
      addLog('error', error.shortMessage || error.message);
    }
  };

  // Claim refund
  const handleClaimRefund = async () => {
    if (!contract) return;

    try {
      addLog('pending', 'Claiming refund...');
      const tx = await contract.claimRefund();
      addLog('pending', `Transaction: ${tx.hash}`);
      await tx.wait();
      addLog('success', 'Refund claimed successfully', tx.hash);
      fetchAuctionInfo();
    } catch (error: any) {
      addLog('error', error.shortMessage || error.message);
    }
  };

  // Request finalize
  const handleRequestFinalize = async () => {
    if (!contract) return;

    try {
      addLog('pending', 'Requesting auction finalization...');
      const tx = await contract.requestFinalize();
      addLog('pending', `Transaction: ${tx.hash}`);
      await tx.wait();
      addLog('success', 'Finalization requested - decryption in progress', tx.hash);
      fetchAuctionInfo();
    } catch (error: any) {
      addLog('error', error.shortMessage || error.message);
    }
  };

  // Owner functions
  const handlePauseAuction = async () => {
    if (!contract) return;
    try {
      addLog('pending', 'Pausing auction...');
      const tx = await contract.pauseAuction();
      await tx.wait();
      addLog('success', 'Auction paused', tx.hash);
      fetchOwnerInfo();
    } catch (error: any) {
      addLog('error', error.shortMessage || error.message);
    }
  };

  const handleUnpauseAuction = async () => {
    if (!contract) return;
    try {
      addLog('pending', 'Unpausing auction...');
      const tx = await contract.unpauseAuction();
      await tx.wait();
      addLog('success', 'Auction unpaused', tx.hash);
      fetchOwnerInfo();
    } catch (error: any) {
      addLog('error', error.shortMessage || error.message);
    }
  };

  const handleUpdateBeneficiary = async () => {
    if (!contract || !newBeneficiary) return;
    try {
      addLog('pending', 'Updating beneficiary...');
      const tx = await contract.updateBeneficiary(newBeneficiary);
      await tx.wait();
      addLog('success', 'Beneficiary updated', tx.hash);
      setNewBeneficiary('');
      fetchOwnerInfo();
    } catch (error: any) {
      addLog('error', error.shortMessage || error.message);
    }
  };

  const handleUpdateFeeCollector = async () => {
    if (!contract || !newFeeCollector) return;
    try {
      addLog('pending', 'Updating fee collector...');
      const tx = await contract.updateFeeCollector(newFeeCollector);
      await tx.wait();
      addLog('success', 'Fee collector updated', tx.hash);
      setNewFeeCollector('');
      fetchOwnerInfo();
    } catch (error: any) {
      addLog('error', error.shortMessage || error.message);
    }
  };

  const handleTransferOwnership = async () => {
    if (!contract || !newOwner) return;
    if (!window.confirm('⚠️ WARNING: This will transfer ownership permanently. Continue?')) return;
    
    try {
      addLog('pending', 'Transferring ownership...');
      const tx = await contract.transferOwnership(newOwner);
      await tx.wait();
      addLog('success', 'Ownership transferred', tx.hash);
      setNewOwner('');
      fetchOwnerInfo();
    } catch (error: any) {
      addLog('error', error.shortMessage || error.message);
    }
  };

  const handleWithdrawFees = async () => {
    if (!contract) return;
    try {
      addLog('pending', 'Withdrawing platform fees...');
      const tx = await contract.withdrawPlatformFees();
      await tx.wait();
      addLog('success', 'Fees withdrawn', tx.hash);
      fetchOwnerInfo();
    } catch (error: any) {
      addLog('error', error.shortMessage || error.message);
    }
  };

  // Auto-fetch data - IMPROVED: Every 5 seconds instead of 10
  useEffect(() => {
    if (!contract) return;

    fetchAuctionInfo();
    fetchOwnerInfo();

    const interval = setInterval(() => {
      fetchAuctionInfo();
      fetchOwnerInfo();
    }, 5000); // 5 seconds for real-time updates

    return () => clearInterval(interval);
  }, [contract, fetchAuctionInfo, fetchOwnerInfo]);

  // Listen to account changes
  useEffect(() => {
    if (!window.ethereum) return;

    const handleAccountsChanged = (accounts: string[]) => {
      if (accounts.length === 0) {
        setIsConnected(false);
        setAccount('');
        addLog('info', 'Wallet disconnected');
      } else {
        setAccount(accounts[0]);
        addLog('info', `Account changed to ${accounts[0].slice(0, 6)}...${accounts[0].slice(-4)}`);
      }
    };

    window.ethereum.on('accountsChanged', handleAccountsChanged);
    return () => window.ethereum.removeListener('accountsChanged', handleAccountsChanged);
  }, []);

  const isOwner = account && contractOwner && account.toLowerCase() === contractOwner.toLowerCase();

  return (
    <div className="container">
      {/* Header */}
      <div className="header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <h1>ZAMA</h1>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <a 
              href="https://x.com/Quangx199x" 
              target="_blank" 
              rel="noopener noreferrer"
              style={{ 
                color: 'var(--green)', 
                fontSize: '1.5rem',
                textDecoration: 'none',
                transition: 'color 0.3s'
              }}
              onMouseEnter={(e) => e.currentTarget.style.color = 'var(--pink)'}
              onMouseLeave={(e) => e.currentTarget.style.color = 'var(--green)'}
              title="Follow on X"
            >
              𝕏
            </a>
            <a 
              href="https://github.com/Quangx199x/" 
              target="_blank" 
              rel="noopener noreferrer"
              style={{ 
                color: 'var(--green)', 
                fontSize: '1.5rem',
                textDecoration: 'none',
                transition: 'color 0.3s'
              }}
              onMouseEnter={(e) => e.currentTarget.style.color = 'var(--pink)'}
              onMouseLeave={(e) => e.currentTarget.style.color = 'var(--green)'}
              title="View on GitHub"
            >
              ⚡
            </a>
          </div>
        </div>
        <p>[SYSTEM ONLINE] FHE AUCTION V3 $</p>
      </div>

      {/* Top Grid - Compact Version */}
      <div className="grid">
        {/* Wallet Init - Compact */}
        <div className="panel glow" style={{ padding: '0.75rem' }}>
          <div className="panel-header" style={{ marginBottom: '0.5rem' }}>&gt; &gt; INIT WALLET SERVICE & FHE SDK</div>
          
          <div className="info-item" style={{ marginBottom: '0.3rem' }}>
            <div className="info-label">[STATUS] Wallet:</div>
            <div style={{ color: isConnected ? 'var(--green)' : 'var(--red)' }}>
              {isConnected ? 'CONNECTED' : 'DISCONNECTED'}
            </div>
          </div>

          {isConnected && (
            <div className="info-item" style={{ marginBottom: '0.3rem' }}>
              <div className="info-label">[ADDRESS]</div>
              <div style={{ fontSize: '0.8rem', wordBreak: 'break-all' }}>
                {account.slice(0, 6)}...{account.slice(-4)}
              </div>
            </div>
          )}

          <div className="info-item" style={{ marginBottom: '0.3rem' }}>
            <div className="info-label">[FHE SDK]</div>
            <div style={{ color: fheStatus === 'Ready' ? 'var(--green)' : 'var(--green-dark)', fontSize: '0.9rem' }}>
              {fheStatus}
            </div>
          </div>

          <button 
            className="btn" 
            onClick={connectWallet} 
            disabled={isConnected}
            style={{ padding: '0.5rem', fontSize: '0.85rem', marginTop: '0.5rem' }}
          >
            {isConnected ? 'CONNECTED' : 'CONNECT WALLET'}
          </button>

          {isConnected && (
            <button 
              className="btn" 
              onClick={initFHE} 
              disabled={fheStatus === 'Ready' || fheStatus === 'Initializing...'}
              style={{ padding: '0.5rem', fontSize: '0.85rem', marginTop: '0.3rem' }}
            >
              {fheStatus === 'Ready' ? 'SDK READY' : fheStatus === 'Initializing...' ? 'INIT...' : 'INIT FHE SDK'}
            </button>
          )}
        </div>

        {/* Auction Data - Compact Version */}
        <div className="panel glow" style={{ padding: '0.75rem' }}>
          <div className="panel-header" style={{ marginBottom: '0.5rem' }}>&gt; &gt; AUCTION DATA FEED (FHE PROTECTED)</div>

          <div className="info-grid" style={{ gap: '0.5rem' }}>
            <div>
              <div className="info-label">[ROUND]</div>
              <div className="info-value">#{auctionData.round}</div>
            </div>

            <div>
              <div className="info-label">[VALID BIDDERS]</div>
              <div className="info-value">{auctionData.validBidders} / 50</div>
            </div>

            <div>
              <div className="info-label">[STATE]</div>
              <div className="badge" style={{ fontSize: '0.85rem' }}>{auctionData.state}</div>
            </div>

            <div>
              <div className="info-label">[CURRENT LEADER]</div>
              <div className="info-value" style={{ fontSize: '0.75rem' }}>
                {auctionData.currentLeader === 'None' ? 'None' : 
                  `${auctionData.currentLeader.slice(0, 6)}...${auctionData.currentLeader.slice(-4)}`}
              </div>
            </div>

            <div>
              <div className="info-label">[WINNING BID]</div>
              <div className="info-value" style={{ fontSize: '0.85rem' }}>
                0.000 ETH <span className="badge-encrypted" style={{ fontSize: '0.7rem' }}>🔒 ENCRYPTED</span>
              </div>
            </div>

            <div>
              <div className="info-label">[MIN INCREMENT]</div>
              <div className="info-value" style={{ fontSize: '0.75rem' }}>
                {auctionData.minIncrement.includes('ETH') ? 
                  auctionData.minIncrement : 
                  `${parseFloat(auctionData.minIncrement).toFixed(8)} ETH`} (1 Gwei)
              </div>
            </div>
          </div>

          {/* Compact Block Info */}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.5rem', fontSize: '0.8rem' }}>
            <div>
              <span className="info-label" style={{ fontSize: '0.7rem' }}>[CURRENT BLOCK]</span>{' '}
              <span className="info-value" style={{ fontSize: '0.8rem' }}>{auctionData.currentBlock.toLocaleString()}</span>
            </div>
            <div>
              <span className="info-label" style={{ fontSize: '0.7rem' }}>[END BLOCK]</span>{' '}
              <span className="info-value" style={{ fontSize: '0.8rem' }}>{auctionData.endBlock.toLocaleString()}</span>
            </div>
          </div>

          {/* Estimated End Time */}
          {auctionData.estimatedEndTime && (
            <div style={{ marginTop: '0.3rem', fontSize: '0.75rem', textAlign: 'center', color: 'var(--green-dark)' }}>
              [EST. END] {auctionData.estimatedEndTime}
            </div>
          )}
        </div>
      </div>

      {/* Time Remaining Bar - Standalone Section */}
      <div style={{ 
        margin: '1rem 0',
        padding: '1rem',
        border: '2px solid var(--green)',
        background: 'var(--bg-dark)',
        borderRadius: '4px'
      }}>
        <div className="info-label" style={{ textAlign: 'center', marginBottom: '0.5rem' }}>[TIME REMAINING]</div>
        <div style={{ 
          fontSize: '3rem', 
          fontFamily: 'var(--font-mono)',
          color: 'var(--green)',
          textAlign: 'center',
          marginBottom: '0.75rem',
          letterSpacing: '0.1em',
          fontWeight: 'bold'
        }}>
          {auctionData.timeRemaining}
        </div>
        
        {/* Progress Bar */}
        <div style={{
          width: '100%',
          height: '2rem',
          background: 'var(--bg-dark)',
          border: '2px solid var(--green-dark)',
          position: 'relative',
          overflow: 'hidden',
          borderRadius: '4px'
        }}>
          <div style={{
            width: `${auctionData.progress}%`,
            height: '100%',
            background: 'linear-gradient(90deg, var(--green), var(--pink))',
            transition: 'width 0.3s ease',
            boxShadow: '0 0 10px var(--green)'
          }} />
          <div style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            color: 'var(--green)',
            fontSize: '0.9rem',
            fontWeight: 'bold',
            textShadow: '0 0 5px black'
          }}>
            {auctionData.progress.toFixed(1)}%
          </div>
        </div>
      </div>

      {/* Tab Selector */}
      <div className="tabs">
        <button 
          className={`tab ${activeTab === 'user' ? 'active' : ''}`}
          onClick={() => setActiveTab('user')}
        >
          ⚡ USER INTERFACE
        </button>
        <button 
          className={`tab ${activeTab === 'owner' ? 'active' : ''}`}
          onClick={() => setActiveTab('owner')}
        >
          👑 OWNER CONTROL
        </button>
      </div>

      {/* Main Content */}
      {activeTab === 'user' ? (
        <div>
          <div className="panel glow">
            <div className="panel-header">&gt; PLACE ENCRYPTED BID</div>

            <div className="info-item">
              <div className="info-label">[YOUR BID AMOUNT] (in ETH)</div>
              <input 
                className="input" 
                type="number" 
                step="0.001"
                placeholder="e.g., 0.05"
                value={bidAmount}
                onChange={(e) => setBidAmount(e.target.value)}
                disabled={!isConnected || fheStatus !== 'Ready'}
              />
            </div>

            <div className="info-item">
              <div className="info-label">[DEPOSIT AMOUNT] (in ETH - must be ≥ min deposit)</div>
              <input 
                className="input" 
                type="number" 
                step="0.001"
                placeholder="e.g., 0.1"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                disabled={!isConnected || fheStatus !== 'Ready'}
              />
              <div style={{ fontSize: '0.75rem', color: 'var(--green-dark)', marginTop: '0.25rem' }}>
                Higher deposits increase your chances of winning
              </div>
            </div>

            <button 
              className="btn" 
              onClick={handleSubmitBid}
              disabled={!bidAmount || !depositAmount || !isConnected || fheStatus !== 'Ready' || isSubmitting}
            >
              {isSubmitting ? 'SUBMITTING...' : '🔒 SUBMIT ENCRYPTED BID'}
            </button>

            <div style={{ 
              marginTop: '0.5rem', 
              padding: '0.5rem',
              border: '1px solid var(--green-dark)',
              fontSize: '0.75rem',
              color: 'var(--green-dark)'
            }}>
              [INFO] Your bid is fully encrypted using FHE. No one can see your bid amount, not even the contract owner!
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">&gt; YOUR ACCOUNT STATUS</div>

            <div className="info-item">
              <div className="info-label">[BID STATUS]</div>
              <div className={bidderInfo.hasBidded ? 'badge' : 'badge-encrypted badge'}>
                {bidderInfo.hasBidded ? (bidderInfo.cancelled ? '❌ CANCELLED' : '✓ ACTIVE') : 'NO BID'}
              </div>
            </div>

            <div className="info-item">
              <div className="info-label">[PENDING REFUND]</div>
              <div className="info-value">{parseFloat(pendingRefund).toFixed(4)} ETH</div>
            </div>

            <div className="info-item">
              <div className="info-label">[YOUR DEPOSIT]</div>
              <div className="info-value">{parseFloat(bidderInfo.deposit).toFixed(4)} ETH</div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <button 
                className="btn" 
                onClick={handleClaimRefund}
                disabled={parseFloat(pendingRefund) === 0}
              >
                CLAIM REFUND
              </button>
              <button 
                className="btn" 
                onClick={handleCancelBid}
                disabled={!bidderInfo.hasBidded || bidderInfo.cancelled}
              >
                CANCEL BID
              </button>
            </div>

            {auctionData.state === 'ENDED' && (
              <button className="btn" onClick={handleRequestFinalize} style={{ marginTop: '0.5rem' }}>
                REQUEST FINALIZE
              </button>
            )}
          </div>

          <div className="panel">
            <div className="panel-header">&gt; CURRENT ROUND BIDDERS ({roundBidders.length}/50)</div>
            {roundBidders.length === 0 ? (
              <div className="empty">
                [NO BIDDERS YET]<br />
                Be the first to place a bid!
              </div>
            ) : (
              <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
                {roundBidders.map((bidder, i) => (
                  <div key={i} style={{ 
                    padding: '0.5rem',
                    borderBottom: '1px solid var(--green-dark)',
                    display: 'flex',
                    justifyContent: 'space-between'
                  }}>
                    <span>[{i + 1}] {bidder.slice(0, 6)}...{bidder.slice(-4)}</span>
                    {bidder.toLowerCase() === account.toLowerCase() && (
                      <span className="badge">YOU</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div>
          {/* NEW: Owner Control Panel with Decryption Status */}
          <div className="panel glow" style={{ borderColor: isOwner ? 'var(--pink)' : 'var(--red)' }}>
            <div className="panel-header">&gt; &gt; AUCTION CONTROL PANEL</div>

            <div className="info-item">
              <div className="info-label">[OWNER ADDRESS]</div>
              <div style={{ fontSize: '0.85rem', wordBreak: 'break-all' }}>
                {contractOwner ? (isConnected ? 
                  `${contractOwner.slice(0, 6)}...${contractOwner.slice(-4)}` : 
                  'Not Connected') : 'Loading...'}
              </div>
              {isOwner && (
                <div className="badge" style={{ marginTop: '0.5rem', background: 'var(--pink)' }}>
                  ✓ YOU ARE OWNER
                </div>
              )}
              {!isOwner && isConnected && contractOwner && (
                <div className="badge-encrypted badge" style={{ marginTop: '0.5rem' }}>
                  ⚠ NOT OWNER
                </div>
              )}
            </div>

            <div className="info-item">
              <div className="info-label">[DECRYPTION STATUS]</div>
              <div className={
                decryptionStatus === 'IDLE' ? 'badge' : 
                decryptionStatus === 'PROCESSING' ? 'badge' : 
                'badge'
              } style={{
                background: decryptionStatus === 'IDLE' ? 'transparent' :
                           decryptionStatus === 'PROCESSING' ? 'var(--pink)' :
                           'var(--green)'
              }}>
                {decryptionStatus}
              </div>
            </div>

            {/* Owner Control Buttons */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '1rem' }}>
              <button 
                className="btn" 
                onClick={handleRequestFinalize}
                disabled={!isOwner || auctionData.state !== 'ENDED' || decryptionStatus === 'PROCESSING'}
                style={{ 
                  borderColor: auctionData.state === 'ENDED' ? 'var(--green)' : 'var(--green-dark)',
                  color: auctionData.state === 'ENDED' ? 'var(--green)' : 'var(--green-dark)'
                }}
              >
                REQUEST FINALIZE
              </button>
              
              <button 
                className="btn btn-red" 
                disabled={true}
                style={{ opacity: 0.5 }}
              >
                FORCE FINALIZE
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <button 
                className="btn btn-red" 
                disabled={true}
                style={{ opacity: 0.5 }}
              >
                CANCEL DECRYPTION
              </button>
              
              <button 
                className="btn btn-red" 
                disabled={true}
                style={{ opacity: 0.5 }}
              >
                EMERGENCY END
              </button>
            </div>

            <div style={{ 
              marginTop: '0.5rem', 
              padding: '0.5rem',
              border: '1px solid var(--pink)',
              color: 'var(--pink)',
              fontSize: '0.75rem'
            }}>
              [NOTE] Advanced controls are disabled in this version. Only REQUEST FINALIZE is available when auction ENDED.
            </div>
          </div>

          <div className="panel glow">
            <div className="panel-header">&gt; AUCTION STATUS CONTROL</div>

            <div className="info-item">
              <div className="info-label">[AUCTION STATUS]</div>
              <div className={isPaused ? 'badge-encrypted badge' : 'badge'}>
                {isPaused ? '⏸ PAUSED' : '▶ RUNNING'}
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <button 
                className="btn" 
                onClick={handlePauseAuction} 
                disabled={!isOwner || isPaused}
              >
                PAUSE AUCTION
              </button>
              <button 
                className="btn" 
                onClick={handleUnpauseAuction} 
                disabled={!isOwner || !isPaused}
              >
                UNPAUSE AUCTION
              </button>
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">&gt; CONFIGURATION MANAGEMENT</div>

            <div className="info-item">
              <div className="info-label">[CURRENT BENEFICIARY]</div>
              <div style={{ fontSize: '0.8rem' }}>
                {beneficiaryAddr ? `${beneficiaryAddr.slice(0, 10)}...${beneficiaryAddr.slice(-8)}` : 'Loading...'}
              </div>
            </div>

            <input 
              className="input" 
              placeholder="New Beneficiary Address (0x...)"
              value={newBeneficiary}
              onChange={(e) => setNewBeneficiary(e.target.value)}
              disabled={!isOwner}
            />

            <div className="info-item">
              <div className="info-label">[CURRENT FEE COLLECTOR]</div>
              <div style={{ fontSize: '0.8rem' }}>
                {feeCollectorAddr ? `${feeCollectorAddr.slice(0, 10)}...${feeCollectorAddr.slice(-8)}` : 'Loading...'}
              </div>
            </div>

            <input 
              className="input" 
              placeholder="New Fee Collector Address (0x...)"
              value={newFeeCollector}
              onChange={(e) => setNewFeeCollector(e.target.value)}
              disabled={!isOwner}
            />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <button 
                className="btn" 
                onClick={handleUpdateBeneficiary} 
                disabled={!isOwner || !newBeneficiary}
              >
                UPDATE BENEFICIARY
              </button>
              <button 
                className="btn" 
                onClick={handleUpdateFeeCollector} 
                disabled={!isOwner || !newFeeCollector}
              >
                UPDATE FEE COLLECTOR
              </button>
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">&gt; PLATFORM FEE MANAGEMENT</div>

            <div className="info-item">
              <div className="info-label">[TOTAL COLLECTED FEES]</div>
              <div className="info-value">{parseFloat(totalFees).toFixed(4)} ETH</div>
            </div>

            <div className="info-item">
              <div className="info-label">[FEE PERCENTAGE]</div>
              <div style={{ fontSize: '1.2rem' }}>2.5% (250 basis points)</div>
            </div>

            <button 
              className="btn" 
              onClick={handleWithdrawFees} 
              disabled={!isOwner || parseFloat(totalFees) === 0}
            >
              WITHDRAW PLATFORM FEES
            </button>
          </div>

          <div className="panel">
            <div className="panel-header">&gt; OWNERSHIP MANAGEMENT</div>

            <input 
              className="input" 
              placeholder="New Owner Address (0x...)"
              value={newOwner}
              onChange={(e) => setNewOwner(e.target.value)}
              disabled={!isOwner}
            />

            <button 
              className="btn btn-red" 
              onClick={handleTransferOwnership} 
              disabled={!isOwner || !newOwner}
            >
              TRANSFER OWNERSHIP
            </button>

            <div style={{ 
              marginTop: '0.5rem', 
              padding: '0.5rem',
              border: '1px solid var(--red)',
              color: 'var(--red)',
              fontSize: '0.75rem'
            }}>
              [WARNING] This action is IRREVERSIBLE!
            </div>
          </div>
        </div>
      )}

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
                    style={{ color: 'var(--pink)', fontSize: '0.75rem' }}
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
            style={{ 
              color: 'var(--pink)', 
              textDecoration: 'none',
              fontWeight: 'bold',
              transition: 'color 0.3s'
            }}
            onMouseEnter={(e) => e.currentTarget.style.color = 'var(--green)'}
            onMouseLeave={(e) => e.currentTarget.style.color = 'var(--pink)'}
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
