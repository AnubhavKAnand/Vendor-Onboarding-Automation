import React, { useState, useEffect, useRef } from 'react';
import { 
  Inbox, UploadCloud, CheckCircle, XCircle, Activity, 
  FileText, Zap, ShieldAlert, Check, RefreshCw, File,
  Building, CreditCard, History, Briefcase, Sparkles, AlertCircle 
} from 'lucide-react';

const API_BASE = 'http://localhost:4004/api/v1/vendor-onboarding';

// --- UI COMPONENTS ---
const Badge = ({ children, color }) => {
  const colors = {
    gray: 'bg-slate-100 text-slate-700 border-slate-200',
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    orange: 'bg-amber-50 text-amber-700 border-amber-200',
    red: 'bg-rose-50 text-rose-700 border-rose-200',
    indigo: 'bg-indigo-50 text-indigo-700 border-indigo-200'
  };
  return (
    <span className={`px-2.5 py-1 rounded-md text-xs font-semibold border ${colors[color] || colors.gray}`}>
      {children}
    </span>
  );
};

// --- MAIN APP SHELL ---
export default function App() {
  const [activeTab, setActiveTab] = useState('inbox'); 
  const [vendors, setVendors] = useState([]);
  const [selectedVendor, setSelectedVendor] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchVendors = async () => {
    try {
      // 🚀 Bulletproof cache-buster: append the exact millisecond to the URL
      const timestamp = new Date().getTime(); 
      const res = await fetch(
        `${API_BASE}/Vendors?$expand=RLBatch,ExtractionLog,Documents,BankAccounts,ApprovalReviews&$orderby=createdAt desc&_t=${timestamp}`,
        { 
          headers: { 
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
          } 
        }
      );
      
      const data = await res.json();
      setVendors(data.value || []);
    } catch (err) {
      console.error('Failed to fetch vendors:', err);
    }
  };

  useEffect(() => {
    fetchVendors();
  }, []);

  const getFilteredVendors = () => {
    // 🚀 Primary Queue shows BOTH 'Pending' and 'Draft' (files currently being processed by AI)
    if (activeTab === 'active') return vendors.filter(v => ['Pending', 'Draft'].includes(v.Status)); 
    
    // 🚀 Missing Queue ONLY shows 'Action-Required'
    if (activeTab === 'missing') return vendors.filter(v => v.Status === 'Action-Required');
    
    if (activeTab === 'compliance') return vendors.filter(v => v.Status === 'Compliance-Review');
    if (activeTab === 'finance') return vendors.filter(v => v.Status === 'Finance-Review');
    if (activeTab === 'approved') return vendors.filter(v => v.Status === 'Auto-Approved');
    if (activeTab === 'rejected') return vendors.filter(v => v.Status === 'Auto-Rejected');
    return [];
  };

  const fileInputRef = useRef(null);
  const [dragActive, setDragActive] = useState(false);

  const processFile = async (file) => {
    if (!file) return;
    setLoading(true);

    // 1. Get the file extension dynamically (e.g., 'PDF', 'PNG')
    const ext = file.name.split('.').pop().toUpperCase();
    
    // 2. Read the actual file data as a Base64 string
    const reader = new FileReader();
    reader.onloadend = async () => {
      const base64Data = reader.result; // This contains the actual file bytes!

      try {
        const companyNameGuess = file.name.replace('.pdf', '').replace(/[-_]/g, ' ');
        
        // Create Draft Vendor
        const vendorRes = await fetch(`${API_BASE}/Vendors`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ CompanyName: companyNameGuess, Country: 'USA' })
        });
        const newVendor = await vendorRes.json();

        // Post the Document with the REAL Base64 content and dynamic DocumentType
        await fetch(`${API_BASE}/VendorDocuments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            Vendor_ID: newVendor.ID,
            DocumentType: ext,        // <--- FIXED: Now dynamically 'PDF', 'JPG', etc.
            URL: `local-upload://${file.name}`,
            Content: base64Data,      // <--- FIXED: Passing the actual file data!
            UploadDate: new Date().toISOString().split('T')[0]
          })
        });

        alert(`File "${file.name}" ingested! AI Pipeline is analyzing the document.`);
        
        setTimeout(() => {
          fetchVendors();
          setActiveTab('active');
        }, 6000);

      } catch (err) {
        console.error('Upload failed:', err);
        alert('Upload failed. Check backend console.');
      } finally {
        setLoading(false);
      }
    };
    
    // Trigger the file read
    reader.readAsDataURL(file);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const handleDecision = async (trueAction) => {
    if (!selectedVendor) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/submitFinalDecision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vendorId: selectedVendor.ID,
          trueAction: trueAction,
          reviewerName: 'Lead Architect',
          department: 'Executive',
          comments: `Routed via React Dashboard to ${trueAction}`
        })
      });

      if (!res.ok) throw new Error(await res.text());
      
      // Close the modal/sidebar first
      setSelectedVendor(null); 
      
      // Re-fetch vendors with a cache-buster to ensure we get the updated backend Status
      await fetchVendors(); 

      if (trueAction === 'Auto-Approve') setActiveTab('approved');
      if (trueAction === 'Auto-Reject') setActiveTab('rejected');
      if (trueAction === 'Route-Compliance') setActiveTab('compliance');
      if (trueAction === 'Route-Finance') setActiveTab('finance');

    } catch (err) {
      alert(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };


// 2. Remove the confusing fallback data from the AI parser
const getAiExtractionData = (vendor) => {
  try {
    const logs = vendor.ExtractionLog || vendor.AgentExtractionLogs || [];
    const log = Array.isArray(logs) ? logs[0] : logs;
    
    if (log && log.RawLLMOutput) {
      const raw = JSON.parse(log.RawLLMOutput);
      
      return {
        "Company Name": { value: raw.CompanyName || "Not Found", confidence: 0.99 },
        "Tax ID": { value: raw.TaxID || "Not Found", confidence: 0.95 },
        "Industry": { value: raw.Industry || "Not Found", confidence: 0.90 },
        "Country": { value: raw.Country || "Not Found", confidence: 0.99 },
        "Bank Account": { value: raw.BankAccount?.AccountNumber ? `Acct: ${raw.BankAccount.AccountNumber}` : "Not Found", confidence: 0.85 }
      };
    }
  } catch (e) {
    console.warn('Could not parse live AI JSON.', e);
  }

  // 🚀 NEW: Show a processing state instead of fake fallback data
  return {
    "AI Pipeline": { value: "Extracting document data...", confidence: 0.00 }
  };
};



  const IngestionHub = () => (
    <div className="grid grid-cols-2 gap-6 h-full">
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 flex flex-col p-6 items-center justify-center text-center">
         <h2 className="font-bold text-slate-800 mb-2 flex items-center gap-2"><Inbox size={20}/> Email Queue Monitoring</h2>
         <p className="text-slate-500 text-sm">Listening on: compliance@acmecorp.com</p>
         <div className="mt-6 w-12 h-1 bg-indigo-100 rounded-full overflow-hidden">
           <div className="w-1/2 h-full bg-indigo-500 animate-pulse"></div>
         </div>
      </div>

      <div 
        className={`bg-white rounded-xl shadow-sm border-2 border-dashed flex flex-col items-center justify-center p-8 text-center transition ${dragActive ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200'}`}
        onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
      >
        <input 
          type="file" 
          ref={fileInputRef} 
          className="hidden" 
          accept=".pdf,.png,.jpg"
          onChange={(e) => processFile(e.target.files[0])}
        />
        <div className={`h-16 w-16 rounded-full flex items-center justify-center mb-4 ${dragActive ? 'bg-indigo-200 text-indigo-700' : 'bg-blue-50 text-blue-600'}`}>
          <UploadCloud size={32} />
        </div>
        <h2 className="text-lg font-bold text-slate-800">Drag & Drop Documents</h2>
        <p className="text-slate-500 text-sm mt-2 max-w-xs">Drop a PDF here to instantly trigger the SAP CAP Agentic AI pipeline.</p>
        <button 
          onClick={() => fileInputRef.current.click()} 
          disabled={loading}
          className="mt-6 px-6 py-2.5 bg-slate-900 text-white text-sm font-medium rounded-lg shadow hover:bg-slate-800 transition disabled:opacity-50 flex items-center gap-2"
        >
          {loading ? <RefreshCw size={16} className="animate-spin"/> : <FileText size={16} />}
          {loading ? 'Ingesting...' : 'Browse Local Files'}
        </button>
      </div>
    </div>
  );

  const VendorWorkspace = () => {
    const list = getFilteredVendors();

    return (
      <div className="flex gap-6 h-full">
        <div className="w-1/3 bg-white border border-slate-200 rounded-xl shadow-sm flex flex-col overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
            <h3 className="font-bold text-slate-800 capitalize">{activeTab.replace('-', ' ')} Queue</h3>
            <span className="text-xs font-bold bg-slate-200 text-slate-600 px-2 py-1 rounded-md">{list.length}</span>
          </div>
          <div className="overflow-y-auto flex-1 divide-y divide-slate-100">
            {list.map(v => (
              <div 
                key={v.ID} 
                onClick={() => setSelectedVendor(v)}
                className={`p-4 cursor-pointer transition ${selectedVendor?.ID === v.ID ? 'bg-indigo-50 border-l-4 border-indigo-600' : 'hover:bg-slate-50 border-l-4 border-transparent'}`}
              >
                <h4 className="font-semibold text-slate-900 text-sm truncate">{v.CompanyName}</h4>
                <div className="flex justify-between items-center mt-3">
                  <Badge color={v.Status.includes('Approve') ? 'green' : v.Status.includes('Reject') ? 'red' : v.Status === 'Draft' ? 'gray' : 'orange'}>{v.Status}</Badge>
                  <span className="text-xs font-mono text-slate-500">Risk: {v.RiskScore || '--'}</span>
                </div>
              </div>
            ))}
            {list.length === 0 && !loading && (
              <div className="p-8 text-center text-slate-400 flex flex-col items-center">
                <CheckCircle size={32} className="mb-2 opacity-50"/>
                <p className="text-sm">Queue is empty.</p>
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto pr-2">
          {selectedVendor ? (
            <div className="flex flex-col gap-6 pb-6">
              
              <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
                <div className="flex justify-between items-start">
                  <div>
                    <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
                      <Building size={24} className="text-slate-400"/> {selectedVendor.CompanyName}
                    </h1>
                    <p className="text-slate-500 text-sm mt-1 font-mono">{selectedVendor.ID}</p>
                  </div>
                  <Badge color={selectedVendor.Status.includes('Approve') ? 'green' : selectedVendor.Status.includes('Reject') ? 'red' : 'orange'}>
                    {selectedVendor.Status}
                  </Badge>
                </div>
              </div>

              {/* 🚀 NEW: Agentic AI Extraction Panel */}
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                <h2 className="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2">
                  <Sparkles size={18} className="text-indigo-500"/> Agentic AI Document Extraction
                </h2>
                <div className="grid grid-cols-2 gap-4">
                  {Object.entries(getAiExtractionData(selectedVendor)).map(([key, data]) => (
                    <div key={key} className="p-3 border border-slate-100 rounded-lg bg-slate-50 flex flex-col justify-between">
                      <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">{key}</p>
                      <div className="flex justify-between items-center mt-1">
                        <p className="font-medium text-slate-900 truncate pr-2" title={data.value}>{data.value}</p>
                        {/* Heatmap Confidence Badge */}
                        <div className={`text-xs font-bold px-1.5 py-0.5 rounded shadow-sm whitespace-nowrap ${
                          data.confidence > 0.90 ? 'bg-emerald-100 text-emerald-700' : 
                          data.confidence > 0.70 ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'
                        }`}>
                          {(data.confidence * 100).toFixed(0)}%
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-6">
                <div className="bg-slate-900 text-white rounded-xl shadow-md border border-slate-800 p-6 flex flex-col">
                  <h2 className="text-lg font-bold flex items-center gap-2 mb-6 text-indigo-400"><Zap size={18}/> RL Shadow Agent</h2>
                  <div className="bg-slate-800 rounded-lg p-4 border border-slate-700 flex-1">
                    <p className="text-slate-400 text-xs uppercase tracking-wide mb-1">Predicted Routing</p>
                    <p className="text-xl font-bold text-white">
                      {selectedVendor.RLBatch?.PredictedAction || 'Awaiting Compute...'}
                    </p>
                  </div>
                  {selectedVendor.RLBatch?.Reward !== 0 && (
                    <div className="mt-4 p-3 bg-slate-800/80 rounded-lg flex justify-between items-center border border-slate-700">
                      <span className="text-xs text-slate-400">Reward Signal:</span>
                      <Badge color={selectedVendor.RLBatch?.Reward === 1 ? 'green' : 'red'}>
                        {selectedVendor.RLBatch?.Reward === 1 ? '+1 (Match)' : '-1 (Mismatch)'}
                      </Badge>
                    </div>
                  )}
                </div>

                <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                   <h2 className="text-md font-bold text-slate-800 mb-4 flex items-center gap-2"><CreditCard size={18}/> Bank & KYC Details</h2>
                   {selectedVendor.BankAccounts && selectedVendor.BankAccounts.length > 0 ? (
                     selectedVendor.BankAccounts.map(b => (
                       <div key={b.ID} className="bg-slate-50 p-4 rounded-lg border border-slate-100 mb-2">
                         <div className="flex justify-between mb-2">
                           <span className="text-sm font-semibold">{b.AccountName || 'Unknown Account'}</span>
                           <Badge color={b.IsVerified ? 'green' : 'orange'}>{b.IsVerified ? 'Verified' : 'Unverified'}</Badge>
                         </div>
                         <p className="text-xs text-slate-500 font-mono">ACCT: {b.AccountNumber}</p>
                         <p className="text-xs text-slate-500 font-mono">SWIFT: {b.SwiftCode || 'N/A'}</p>
                       </div>
                     ))
                   ) : (
                     <p className="text-sm text-slate-500 italic">No bank data extracted.</p>
                   )}
                </div>

                <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 col-span-2">
                   <h2 className="text-md font-bold text-slate-800 mb-4 flex items-center gap-2"><File size={18}/> Uploaded Documents</h2>
                   <div className="border border-slate-100 rounded-lg overflow-hidden">
                     <table className="w-full text-sm text-left">
                       <thead className="bg-slate-50 text-slate-500 text-xs uppercase font-semibold">
                         <tr>
                           <th className="px-4 py-3">Type</th>
                           <th className="px-4 py-3">File Name</th>
                           <th className="px-4 py-3">Upload Date</th>
                           <th className="px-4 py-3 text-right">AI Confidence</th>
                         </tr>
                       </thead>
                       <tbody className="divide-y divide-slate-100">
                         {selectedVendor.Documents?.map(d => (
                           <tr key={d.ID} className="bg-white">
                             <td className="px-4 py-3 font-medium text-slate-900">{d.DocumentType}</td>
                             <td className="px-4 py-3 text-slate-500 truncate max-w-xs">{d.URL.replace('local-upload://', '')}</td>
                             <td className="px-4 py-3 text-slate-500">{d.UploadDate}</td>
                             <td className="px-4 py-3 text-right">
                               <Badge color={d.AI_Confidence_Score > 0.85 ? 'green' : 'orange'}>
                                 {d.AI_Confidence_Score ? (d.AI_Confidence_Score * 100).toFixed(1) + '%' : 'Pending'}
                               </Badge>
                             </td>
                           </tr>
                         ))}
                         {(!selectedVendor.Documents || selectedVendor.Documents.length === 0) && (
                           <tr><td colSpan="4" className="px-4 py-4 text-center text-slate-400">No documents found.</td></tr>
                         )}
                       </tbody>
                     </table>
                   </div>
                </div>

              </div>

              {activeTab === 'active' && (
                <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
                  <h3 className="font-bold text-slate-800 mb-4">Human Review & Final Routing</h3>
                  <div className="flex gap-3">
                    <button onClick={() => handleDecision('Auto-Approve')} className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white py-2.5 rounded-lg font-medium shadow text-sm flex justify-center items-center gap-2 transition">
                      <CheckCircle size={18}/> Approve
                    </button>
                    <button onClick={() => handleDecision('Auto-Reject')} className="flex-1 bg-rose-600 hover:bg-rose-700 text-white py-2.5 rounded-lg font-medium shadow text-sm flex justify-center items-center gap-2 transition">
                      <XCircle size={18}/> Reject
                    </button>
                    <button onClick={() => handleDecision('Route-Compliance')} className="flex-1 bg-indigo-100 hover:bg-indigo-200 text-indigo-800 py-2.5 rounded-lg font-medium shadow text-sm flex justify-center items-center gap-2 transition border border-indigo-200">
                      <ShieldAlert size={18}/> Compliance
                    </button>
                    <button onClick={() => handleDecision('Route-Finance')} className="flex-1 bg-blue-100 hover:bg-blue-200 text-blue-800 py-2.5 rounded-lg font-medium shadow text-sm flex justify-center items-center gap-2 transition border border-blue-200">
                      <Briefcase size={18}/> Finance
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-slate-400">
              <FileText size={48} className="mb-4 opacity-20"/>
              <p>Select a vendor record to view details.</p>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-screen bg-slate-50 font-sans">
      
      <div className="w-64 bg-slate-900 text-slate-300 flex flex-col z-20 shadow-xl">
        <div className="p-6">
          <h1 className="text-white font-bold text-xl flex items-center gap-2">
            <Activity size={24} className="text-indigo-500"/> VendorFlow AI
          </h1>
        </div>
        <nav className="flex-1 px-4 space-y-2">
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 mt-4 px-2">Data Ingestion</p>
          <button onClick={() => {setActiveTab('inbox'); setSelectedVendor(null);}} className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition ${activeTab === 'inbox' ? 'bg-indigo-600 text-white shadow-md' : 'hover:bg-slate-800 hover:text-white'}`}>
            <UploadCloud size={18} /> Ingestion Hub
          </button>
          {/* 🚀 NEW BUTTON: Missing Documents */}
          <button onClick={() => {setActiveTab('missing'); setSelectedVendor(null);}} className={`w-full flex items-center justify-between px-4 py-2.5 rounded-lg text-sm font-medium transition ${activeTab === 'missing' ? 'bg-orange-600 text-white shadow-md' : 'hover:bg-slate-800 hover:text-orange-400'}`}>
            <div className="flex items-center gap-3"><AlertCircle size={18} /> Missing Documents</div>
          </button>
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 mt-8 px-2">Active Workflows</p>
          <button onClick={() => {setActiveTab('active'); setSelectedVendor(null);}} className={`w-full flex items-center justify-between px-4 py-2.5 rounded-lg text-sm font-medium transition ${activeTab === 'active' ? 'bg-indigo-600 text-white shadow-md' : 'hover:bg-slate-800 hover:text-white'}`}>
            <div className="flex items-center gap-3"><Activity size={18} /> Primary Queue</div>
          </button>
          
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 mt-8 px-2">Routed Queues</p>
          <button onClick={() => {setActiveTab('compliance'); setSelectedVendor(null);}} className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition ${activeTab === 'compliance' ? 'bg-indigo-900/50 text-indigo-300' : 'hover:bg-slate-800 hover:text-white'}`}>
            <ShieldAlert size={18} /> Compliance Review
          </button>
          <button onClick={() => {setActiveTab('finance'); setSelectedVendor(null);}} className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition ${activeTab === 'finance' ? 'bg-blue-900/50 text-blue-300' : 'hover:bg-slate-800 hover:text-white'}`}>
            <Briefcase size={18} /> Finance Review
          </button>

          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 mt-8 px-2">Audit History</p>
          <button onClick={() => {setActiveTab('approved'); setSelectedVendor(null);}} className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition ${activeTab === 'approved' ? 'bg-slate-800 text-emerald-400' : 'hover:bg-slate-800 hover:text-white'}`}>
            <CheckCircle size={18} /> Approved
          </button>
          <button onClick={() => {setActiveTab('rejected'); setSelectedVendor(null);}} className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition ${activeTab === 'rejected' ? 'bg-slate-800 text-rose-400' : 'hover:bg-slate-800 hover:text-white'}`}>
            <XCircle size={18} /> Rejected
          </button>
        </nav>
        <div className="p-4 border-t border-slate-800 text-xs text-slate-500 text-center">
          Connected to CAP OData V4
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden relative">
        <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-8 z-10 shadow-sm">
          <h2 className="font-bold text-slate-800 capitalize flex items-center gap-2">
            {activeTab === 'inbox' ? <UploadCloud size={20}/> : <History size={20}/>} 
            {activeTab === 'inbox' ? 'Document Ingestion' : `${activeTab.replace('-', ' ')} Workflows`}
          </h2>
          <div className="flex items-center gap-4">
            <button onClick={fetchVendors} className="text-slate-500 hover:text-indigo-600 p-2 rounded-full hover:bg-slate-100 transition">
              <RefreshCw size={18} className={loading ? "animate-spin text-indigo-600" : ""}/>
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-auto p-8 relative bg-slate-50/50">
          {activeTab === 'inbox' ? <IngestionHub /> : <VendorWorkspace />}
        </main>
      </div>
    </div>
  );
}