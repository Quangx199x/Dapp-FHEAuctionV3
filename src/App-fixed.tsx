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
  const [fhePublicKey, setFhePublicKey] = useState<string>(''); // ✅ FIXED: Store public key
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
        return;
      }

      setAccount(accounts[0]);
      setIsConnected(true);
      
      const signer = await provider.getSigner();
      const contractInstance = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
      setContract(contractInstance);
      
      addLog('success', `Connected: ${accounts[0].slice(0, 6)}...${accounts[0].slice(-4)}`);
    } catch (error: any) {
      addLog('error', error.message);
    }
  };

  // ✅ FIXED: Initialize FHE SDK with proper public key extraction
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
      
      // ✅ FIXED: Get and store the public key properly
      const publicKey = instance.getPublicKey();
      
      // Convert public key to bytes32 format if needed
      let publicKeyBytes32: string;
      if (typeof publicKey === 'string') {
        // If it's already a hex string, pad to 32 bytes
        publicKeyBytes32 = ethers.zeroPadValue(publicKey, 32);
      } else if (publicKey instanceof Uint8Array) {
        // Convert Uint8Array to hex and pad
        publicKeyBytes32 = ethers.zeroPadValue(ethers.hexlify(publicKey), 32);
      } else {
        throw new Error('Invalid public key format');
      }
      
      setFheInstance(instance);
      setFhePublicKey(publicKeyBytes32);
      setFheStatus('Ready');
      addLog('success', `FHE SDK initialized. Public Key: ${publicKeyBytes32.slice(0, 10)}...`);
      
    } catch (error: any) {
      setFheStatus('Failed');
      addLog('error', `FHE initialization failed: ${error.message}`);
      console.error(error);
    }
  };

  // Fetch auction info - IMPROVED VERSION
  const fetchAuctionInfo = useCallback(async () => {
    if (!contract) return;

    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const [info, currentBlock, estimatedEnd, minDeposit] = await Promise.all([
        contract.getAuctionInfo(),
        provider.getBlockNumber(),
        contract.getEstimatedEndTime().catch(() => 0),
        contract.minBidDeposit().catch(() => BigInt(10000000)) // 1 Gwei default
      ]);

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
        const bInfo = await contract.getBidderInfo(account);
        setBidderInfo({
          deposit: ethers.formatEther(bInfo.deposit),
          hasBidded: bInfo.hasBidded,
          cancelled: bInfo.cancelled,
        });

        const refund = await contract.pendingRefunds(account);
        setPendingRefund(ethers.formatEther(refund));
      }

      // Fetch round bidders
      const bidders = await contract.getRoundBidders();
      setRoundBidders(bidders);

    } catch (error: any) {
      console.error('Error fetching auction info:', error);
      addLog('error', 'Failed to fetch auction data');
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

  // ✅ FIXED: Submit encrypted bid with correct public key and signature
  const handleSubmitBid = async () => {
    if (!contract || !fheInstance || !account || !bidAmount || !depositAmount || !fhePublicKey) {
      addLog('error', 'Please fill all fields and initialize FHE SDK');
      return;
    }

    try {
      setIsSubmitting(true);
      addLog('pending', `Encrypting bid: ${bidAmount} ETH...`);

      // Convert bid to Gwei (uint64)
      const bidInGwei = Math.floor(parseFloat(bidAmount) * 1e9);
      
      addLog('info', `Bid in Gwei: ${bidInGwei}`);
      
      // ✅ FIXED: Create encrypted input with proper userAddress
      const input = fheInstance.createEncryptedInput(CONTRACT_ADDRESS, account);
      input.add64(BigInt(bidInGwei));
      const encryptedData = await input.encrypt();

      addLog('info', `Encrypted handle: ${encryptedData.handles[0].slice(0, 20)}...`);
      
      // ✅ FIXED: Convert inputProof from Uint8Array to hex string
      let inputProofHex: string;
      if (encryptedData.inputProof instanceof Uint8Array) {
        inputProofHex = ethers.hexlify(encryptedData.inputProof);
      } else if (typeof encryptedData.inputProof === 'string') {
        inputProofHex = encryptedData.inputProof;
      } else {
        throw new Error('Invalid inputProof format');
      }

      addLog('info', `Input proof length: ${inputProofHex.length} bytes`);

      // ✅ FIXED: Generate EIP-712 signature with CORRECT public key
      addLog('pending', 'Generating EIP-712 signature...');
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

      // ✅ FIXED: Sign the REAL public key, not the encrypted handle
      const value = {
        key: fhePublicKey, // ✅ This is the correct FHE public key
      };

      const signature = await signer.signTypedData(domain, types, value);
      
      addLog('info', `Signature: ${signature.slice(0, 20)}...`);

      // ✅ FIXED: Submit bid with correct parameters
      addLog('pending', 'Submitting encrypted bid to blockchain...');

      const tx = await contract.bid(
        encryptedData.handles[0],  // encryptedBid (bytes32)
        inputProofHex,              // inputProof (bytes) - ✅ FIXED: Proper hex format
        fhePublicKey,               // publicKey (bytes32) - ✅ FIXED: Real public key
        signature,                  // signature (bytes) - ✅ FIXED: Signature of public key
        { value: ethers.parseEther(depositAmount) }
      );

      addLog('pending', `Transaction submitted: ${tx.hash}`);
      const receipt = await tx.wait();
      addLog('success', `✅ Bid placed successfully! Block: ${receipt.blockNumber}`, tx.hash);
      
      // Clear form
      setBidAmount('');
      setDepositAmount('');
      
      // Refresh data
      fetchAuctionInfo();

    } catch (error: any) {
      addLog('error', error.message || 'Failed to submit bid');
      console.error('Full error:', error);
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
        setContract(null);
      } else {
        connectWallet();
      }
    };

    window.ethereum.on('accountsChanged', handleAccountsChanged);
    return () => window.ethereum.removeListener('accountsChanged', handleAccountsChanged);
  }, []);

  // Check if user is owner
  const isOwner = account && contractOwner && account.toLowerCase() === contractOwner.toLowerCase();

  return (
    <div className="app-container">
      <div className="header">
        <h1 className="title">🔐 FHE AUCTION</h1>
        <p className="subtitle">Fully Homomorphic Encrypted Bidding System</p>
      </div>

      {/* Connection Panel */}
      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">CONNECTION STATUS</span>
        </div>
        <div className="panel-content">
          <div className="info-grid">
            <div className="info-item">
              <span className="info-label">WALLET:</span>
              <span className="info-value">
                {isConnected ? `${account.slice(0, 6)}...${account.slice(-4)}` : 'Not connected'}
              </span>
            </div>
            <div className="info-item">
              <span className="info-label">FHE SDK:</span>
              <span className={`info-value ${fheStatus === 'Ready' ? 'success' : fheStatus === 'Failed' ? 'error' : 'pending'}`}>
                {fheStatus}
              </span>
            </div>
            {fhePublicKey && (
              <div className="info-item" style={{ gridColumn: '1 / -1' }}>
                <span className="info-label">FHE PUBLIC KEY:</span>
                <span className="info-value" style={{ fontSize: '0.8em', wordBreak: 'break-all' }}>
                  {fhePublicKey}
                </span>
              </div>
            )}
          </div>
          <div className="button-row">
            <button 
              onClick={connectWallet} 
              disabled={isConnected}
              className="btn btn-primary"
            >
              {isConnected ? '✓ CONNECTED' : 'CONNECT WALLET'}
            </button>
            <button 
              onClick={initFHE} 
              disabled={fheStatus === 'Ready' || !isConnected}
              className="btn btn-secondary"
            >
              {fheStatus === 'Ready' ? '✓ FHE READY' : 'INITIALIZE FHE SDK'}
            </button>
          </div>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="tab-nav">
        <button 
          className={`tab-btn ${activeTab === 'user' ? 'active' : ''}`}
          onClick={() => setActiveTab('user')}
        >
          USER ACTIONS
        </button>
        <button 
          className={`tab-btn ${activeTab === 'owner' ? 'active' : ''}`}
          onClick={() => setActiveTab('owner')}
        >
          OWNER CONTROL
        </button>
      </div>

      {/* Auction Data Feed - Always visible */}
      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">📊 AUCTION DATA FEED</span>
          <span className="refresh-indicator">↻ Auto-refresh: 5s</span>
        </div>
        <div className="panel-content">
          <div className="auction-stats">
            <div className="stat-item">
              <div className="stat-label">ROUND</div>
              <div className="stat-value">{auctionData.round}</div>
            </div>
            <div className="stat-item">
              <div className="stat-label">STATE</div>
              <div className={`stat-value state-${auctionData.state.toLowerCase()}`}>
                {auctionData.state}
              </div>
            </div>
            <div className="stat-item">
              <div className="stat-label">VALID BIDDERS</div>
              <div className="stat-value">{auctionData.validBidders}</div>
            </div>
            <div className="stat-item">
              <div className="stat-label">CURRENT LEADER</div>
              <div className="stat-value leader">
                {auctionData.currentLeader === 'None' ? 
                  'None' : 
                  `${auctionData.currentLeader.slice(0, 6)}...${auctionData.currentLeader.slice(-4)}`
                }
              </div>
            </div>
          </div>

          <div className="auction-details">
            <div className="detail-row">
              <span className="detail-label">CURRENT BLOCK:</span>
              <span className="detail-value">{auctionData.currentBlock.toLocaleString()}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">END BLOCK:</span>
              <span className="detail-value">{auctionData.endBlock.toLocaleString()}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">MIN INCREMENT:</span>
              <span className="detail-value">{auctionData.minIncrement}</span>
            </div>
            {auctionData.estimatedEndTime && (
              <div className="detail-row">
                <span className="detail-label">ESTIMATED END:</span>
                <span className="detail-value">{auctionData.estimatedEndTime}</span>
              </div>
            )}
          </div>

          <div className="time-remaining">
            <div className="time-label">TIME REMAINING</div>
            <div className="time-value">{auctionData.timeRemaining}</div>
            <div className="progress-bar">
              <div 
                className="progress-fill" 
                style={{ width: `${auctionData.progress}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* User Actions Tab */}
      {activeTab === 'user' && (
        <>
          {/* Bidding Panel */}
          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">💰 PLACE ENCRYPTED BID</span>
            </div>
            <div className="panel-content">
              <div className="form-group">
                <label className="form-label">BID AMOUNT (ETH)</label>
                <input
                  type="number"
                  step="0.001"
                  value={bidAmount}
                  onChange={(e) => setBidAmount(e.target.value)}
                  placeholder="0.1"
                  className="form-input"
                  disabled={!isConnected || fheStatus !== 'Ready'}
                />
              </div>
              <div className="form-group">
                <label className="form-label">DEPOSIT AMOUNT (ETH)</label>
                <input
                  type="number"
                  step="0.001"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  placeholder="0.1"
                  className="form-input"
                  disabled={!isConnected || fheStatus !== 'Ready'}
                />
                <small className="form-hint">Must be ≥ {auctionData.minIncrement}</small>
              </div>
              <button
                onClick={handleSubmitBid}
                disabled={isSubmitting || !isConnected || fheStatus !== 'Ready' || !bidAmount || !depositAmount}
                className="btn btn-primary btn-large"
              >
                {isSubmitting ? '⏳ SUBMITTING...' : '🔐 SUBMIT ENCRYPTED BID'}
              </button>
            </div>
          </div>

          {/* User Status Panel */}
          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">👤 YOUR STATUS</span>
            </div>
            <div className="panel-content">
              <div className="info-grid">
                <div className="info-item">
                  <span className="info-label">DEPOSIT:</span>
                  <span className="info-value">{bidderInfo.deposit} ETH</span>
                </div>
                <div className="info-item">
                  <span className="info-label">HAS BIDDED:</span>
                  <span className={`info-value ${bidderInfo.hasBidded ? 'success' : ''}`}>
                    {bidderInfo.hasBidded ? '✓ YES' : '✗ NO'}
                  </span>
                </div>
                <div className="info-item">
                  <span className="info-label">CANCELLED:</span>
                  <span className={`info-value ${bidderInfo.cancelled ? 'error' : ''}`}>
                    {bidderInfo.cancelled ? '✓ YES' : '✗ NO'}
                  </span>
                </div>
                <div className="info-item">
                  <span className="info-label">PENDING REFUND:</span>
                  <span className="info-value">{pendingRefund} ETH</span>
                </div>
              </div>
              <div className="button-row">
                <button
                  onClick={handleCancelBid}
                  disabled={!bidderInfo.hasBidded || bidderInfo.cancelled}
                  className="btn btn-danger"
                >
                  CANCEL BID
                </button>
                <button
                  onClick={handleClaimRefund}
                  disabled={parseFloat(pendingRefund) === 0}
                  className="btn btn-success"
                >
                  CLAIM REFUND
                </button>
                <button
                  onClick={handleRequestFinalize}
                  disabled={auctionData.state !== 'ENDED'}
                  className="btn btn-secondary"
                >
                  REQUEST FINALIZE
                </button>
              </div>
            </div>
          </div>

          {/* Active Bidders */}
          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">👥 ACTIVE BIDDERS ({roundBidders.length})</span>
            </div>
            <div className="panel-content">
              {roundBidders.length === 0 ? (
                <p className="no-data">No bidders yet</p>
              ) : (
                <div className="bidder-list">
                  {roundBidders.map((bidder, idx) => (
                    <div key={idx} className="bidder-item">
                      <span className="bidder-number">#{idx + 1}</span>
                      <span className="bidder-address">{bidder}</span>
                      {bidder.toLowerCase() === account.toLowerCase() && (
                        <span className="badge badge-you">YOU</span>
                      )}
                      {bidder.toLowerCase() === auctionData.currentLeader.toLowerCase() && (
                        <span className="badge badge-leader">LEADER</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Owner Control Tab */}
      {activeTab === 'owner' && (
        <>
          {/* Owner Control Panel */}
          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">🎛️ AUCTION CONTROL PANEL</span>
            </div>
            <div className="panel-content">
              <div className="owner-info">
                <div className="info-item">
                  <span className="info-label">OWNER ADDRESS:</span>
                  <span className="info-value">
                    {contractOwner ? `${contractOwner.slice(0, 10)}...${contractOwner.slice(-8)}` : 'Loading...'}
                  </span>
                </div>
                {isOwner ? (
                  <div className="badge badge-owner">✓ YOU ARE OWNER</div>
                ) : (
                  <div className="badge badge-not-owner">⚠ NOT OWNER</div>
                )}
              </div>

              <div className="decryption-status">
                <span className="status-label">DECRYPTION STATUS:</span>
                <span className={`status-value status-${decryptionStatus.toLowerCase()}`}>
                  {decryptionStatus}
                </span>
              </div>

              <div className="control-grid">
                <button
                  onClick={handleRequestFinalize}
                  disabled={!isOwner || auctionData.state !== 'ENDED'}
                  className="btn btn-success"
                  title="Start finalization and decryption process"
                >
                  REQUEST FINALIZE
                </button>
                <button
                  disabled={true}
                  className="btn btn-danger"
                  title="Not implemented in current version"
                >
                  FORCE FINALIZE
                </button>
                <button
                  disabled={true}
                  className="btn btn-danger"
                  title="Not implemented in current version"
                >
                  CANCEL DECRYPTION
                </button>
                <button
                  disabled={true}
                  className="btn btn-danger"
                  title="Not implemented in current version"
                >
                  EMERGENCY END
                </button>
              </div>

              <div className="control-note">
                <small>
                  ⚠️ Advanced controls (FORCE FINALIZE, CANCEL DECRYPTION, EMERGENCY END) are disabled in this version.
                  Only REQUEST FINALIZE is functional.
                </small>
              </div>
            </div>
          </div>

          {/* Auction Management */}
          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">⚙️ AUCTION MANAGEMENT</span>
            </div>
            <div className="panel-content">
              <div className="info-item">
                <span className="info-label">AUCTION STATUS:</span>
                <span className={`info-value ${isPaused ? 'error' : 'success'}`}>
                  {isPaused ? '⏸ PAUSED' : '▶ ACTIVE'}
                </span>
              </div>
              <div className="button-row">
                <button
                  onClick={handlePauseAuction}
                  disabled={!isOwner || isPaused}
                  className="btn btn-warning"
                >
                  PAUSE AUCTION
                </button>
                <button
                  onClick={handleUnpauseAuction}
                  disabled={!isOwner || !isPaused}
                  className="btn btn-success"
                >
                  UNPAUSE AUCTION
                </button>
              </div>
            </div>
          </div>

          {/* Configuration */}
          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">🔧 CONFIGURATION</span>
            </div>
            <div className="panel-content">
              <div className="form-group">
                <label className="form-label">BENEFICIARY</label>
                <div className="form-inline">
                  <input
                    type="text"
                    value={newBeneficiary}
                    onChange={(e) => setNewBeneficiary(e.target.value)}
                    placeholder={beneficiaryAddr}
                    className="form-input"
                    disabled={!isOwner}
                  />
                  <button
                    onClick={handleUpdateBeneficiary}
                    disabled={!isOwner || !newBeneficiary}
                    className="btn btn-secondary btn-small"
                  >
                    UPDATE
                  </button>
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">FEE COLLECTOR</label>
                <div className="form-inline">
                  <input
                    type="text"
                    value={newFeeCollector}
                    onChange={(e) => setNewFeeCollector(e.target.value)}
                    placeholder={feeCollectorAddr}
                    className="form-input"
                    disabled={!isOwner}
                  />
                  <button
                    onClick={handleUpdateFeeCollector}
                    disabled={!isOwner || !newFeeCollector}
                    className="btn btn-secondary btn-small"
                  >
                    UPDATE
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Fee Management */}
          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">💸 FEE MANAGEMENT</span>
            </div>
            <div className="panel-content">
              <div className="info-item">
                <span className="info-label">TOTAL COLLECTED FEES:</span>
                <span className="info-value">{totalFees} ETH</span>
              </div>
              <button
                onClick={handleWithdrawFees}
                disabled={!isOwner || parseFloat(totalFees) === 0}
                className="btn btn-success"
              >
                WITHDRAW PLATFORM FEES
              </button>
            </div>
          </div>

          {/* Ownership Transfer */}
          <div className="panel panel-danger">
            <div className="panel-header">
              <span className="panel-title">⚠️ OWNERSHIP TRANSFER</span>
            </div>
            <div className="panel-content">
              <div className="form-group">
                <label className="form-label">NEW OWNER ADDRESS</label>
                <div className="form-inline">
                  <input
                    type="text"
                    value={newOwner}
                    onChange={(e) => setNewOwner(e.target.value)}
                    placeholder="0x..."
                    className="form-input"
                    disabled={!isOwner}
                  />
                  <button
                    onClick={handleTransferOwnership}
                    disabled={!isOwner || !newOwner}
                    className="btn btn-danger btn-small"
                  >
                    TRANSFER
                  </button>
                </div>
              </div>
              <div className="warning-text">
                ⚠️ WARNING: This action is permanent and irreversible!
              </div>
            </div>
          </div>
        </>
      )}

      {/* Activity Log */}
      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">📝 ACTIVITY LOG</span>
          <button 
            onClick={() => setLogs([])} 
            className="btn btn-small btn-secondary"
          >
            CLEAR
          </button>
        </div>
        <div className="panel-content">
          <div className="log-container">
            {logs.length === 0 ? (
              <p className="no-data">No activity yet</p>
            ) : (
              logs.map((log, idx) => (
                <div key={idx} className={`log-item log-${log.type}`}>
                  <span className="log-time">[{log.time}]</span>
                  <span className="log-msg">{log.msg}</span>
                  {log.txHash && (
                    <a
                      href={`https://sepolia.etherscan.io/tx/${log.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="log-link"
                    >
                      View TX ↗
                    </a>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="footer">
        <p>Powered by Zama FHE Technology | Contract: {CONTRACT_ADDRESS}</p>
        <p className="version">Version 3.1 - Fixed Signature & Proof</p>
      </div>
    </div>
  );
}

export default App;
