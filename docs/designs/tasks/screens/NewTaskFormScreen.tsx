import React from "react";
import * as Icons from "lucide-react";

export interface NewTaskFormScreenProps {
  state: string;
}

/**
 * States:
 * - default: Form displayed with only the required Title input focused. Optional fields hidden.
 * - expanded: Optional fields section (Description, Priority, Due Date, etc.) is expanded and visible.
 */
const NewTaskFormScreen: React.FC<NewTaskFormScreenProps> = ({ state }) => {
  
  const isExpanded = state === 'expanded';

  // --- Render Helpers ---

  const renderNav = () => (
    <nav className="sticky top-0 z-50 bg-[#1E1E1E] border-b-[3px] border-[#FFE135] px-4 py-3 flex items-center gap-4 shadow-lg">
      <button className="bg-[#2a2a2a] p-2 border-2 border-[#555] hover:border-[#00D4FF] transition-colors group">
        <Icons.X className="w-5 h-5 text-[#F5F2E8] group-hover:text-[#00D4FF]" />
      </button>
      <div className="flex-1">
        <div className="bg-[#FFE135] text-[#1E1E1E] px-2 py-1 border-2 border-[#000000] inline-block transform rotate-1 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">
          <span className="font-['Dela_Gothic_One'] text-xl tracking-tight uppercase">New Task</span>
        </div>
      </div>
    </nav>
  );

  const renderStickyFooter = () => (
    <div className="fixed bottom-0 left-0 right-0 bg-[#1E1E1E] border-t-[3px] border-[#555] p-4 z-40 md:hidden">
      <button className="w-full bg-[#FFE135] text-[#1E1E1E] font-['Dela_Gothic_One'] text-xl px-6 py-4 border-[3px] border-[#000000] shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:translate-y-[1px] transition-all uppercase flex items-center justify-center gap-2">
        <Icons.Plus className="w-5 h-5" />
        Create Task
      </button>
    </div>
  );

  const renderForm = () => {
    return (
      <div className="flex-1 p-4 md:p-8 overflow-y-auto pb-40 md:pb-8">
        <div className="w-full max-w-2xl relative mx-auto">
          
          {/* Main Form Sticker */}
          <div className="bg-[#F5F2E8] border-[3px] border-[#000000] p-6 md:p-10 shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] relative transform rotate-[0.5deg]">
            
            {/* Title Input */}
            <div className="mb-8 bg-white border-[2px] border-[#000000] p-4 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">
              <label className="block text-xs font-bold font-['Work_Sans'] uppercase text-[#FF3E8A] mb-2 tracking-widest">
                What needs crushing? *
              </label>
              <input 
                type="text" 
                placeholder="Enter task title..." 
                className="w-full bg-transparent border-b-[3px] border-[#000000] text-2xl md:text-3xl font-['Dela_Gothic_One'] text-[#1E1E1E] leading-tight focus:outline-none focus:border-[#00D4FF] py-2 placeholder-[#aaa]" 
                autoFocus
              />
            </div>

            {/* Expand/Collapse Toggle */}
            <div className="mb-6">
              <button className="flex items-center gap-2 font-['Work_Sans'] font-bold text-[#1E1E1E] text-sm uppercase hover:text-[#00D4FF] transition-colors group">
                <span className="bg-[#000] text-[#FFE135] w-6 h-6 flex items-center justify-center rounded-sm group-hover:bg-[#00D4FF] group-hover:text-[#1E1E1E] transition-colors">
                  {isExpanded ? <Icons.Minus className="w-4 h-4" /> : <Icons.Plus className="w-4 h-4" />}
                </span>
                {isExpanded ? 'Hide Options' : 'Show More Options'}
              </button>
            </div>

            {/* Optional Fields Section */}
            {isExpanded && (
              <div className="space-y-6 pt-6 border-t-2 border-dashed border-[#000000] animate-in slide-in-from-top duration-300">
                
                {/* Description */}
                <div>
                  <label className="block text-xs font-bold font-['Work_Sans'] uppercase text-[#666] mb-2">The Deets</label>
                  <textarea 
                    rows={3} 
                    placeholder="Add description..." 
                    className="w-full bg-white border-[3px] border-[#000000] p-3 font-['Work_Sans'] text-[#1E1E1E] focus:outline-none focus:border-[#00D4FF] resize-none" 
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Priority */}
                  <div>
                    <label className="block text-xs font-bold font-['Work_Sans'] uppercase text-[#666] mb-2">Priority</label>
                    <div className="grid grid-cols-4 md:grid-cols-2 gap-2">
                      {['urgent', 'high', 'medium', 'low'].map((p) => (
                        <button key={p} className={`py-3 text-xs font-bold uppercase border-2 border-[#000000] font-['Work_Sans'] shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-all ${p === 'medium' ? 'bg-[#00D4FF] translate-y-[1px] shadow-none' : 'bg-white hover:bg-[#eee]'}`}>
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Due Date */}
                  <div>
                    <label className="block text-xs font-bold font-['Work_Sans'] uppercase text-[#666] mb-2">Due Date</label>
                    <div className="relative">
                      <input type="date" className="w-full bg-white border-[3px] border-[#000000] p-2 font-['Work_Sans'] text-[#1E1E1E] focus:outline-none focus:border-[#00D4FF]" />
                      <Icons.Calendar className="absolute right-3 top-2.5 w-4 h-4 text-[#666]" />
                    </div>
                  </div>
                </div>

                {/* Assignee & Tags */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="block text-xs font-bold font-['Work_Sans'] uppercase text-[#666] mb-2">Assignee</label>
                    <div className="relative">
                      <Icons.User className="absolute left-3 top-2.5 w-4 h-4 text-[#666]" />
                      <input type="text" placeholder="Who's on it?" className="w-full bg-white border-[3px] border-[#000000] pl-9 p-2 font-['Work_Sans'] text-[#1E1E1E] focus:outline-none focus:border-[#00D4FF]" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-bold font-['Work_Sans'] uppercase text-[#666] mb-2">Tags</label>
                    <div className="relative">
                      <Icons.Tag className="absolute left-3 top-2.5 w-4 h-4 text-[#666]" />
                      <input type="text" placeholder="Add tags..." className="w-full bg-white border-[3px] border-[#000000] pl-9 p-2 font-['Work_Sans'] text-[#1E1E1E] focus:outline-none focus:border-[#00D4FF]" />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Desktop Action Buttons */}
            <div className="mt-8 pt-6 border-t-2 border-dashed border-[#000000] hidden md:flex flex-col md:flex-row gap-4">
              <button className="flex-1 bg-[#FFE135] text-[#1E1E1E] font-['Dela_Gothic_One'] text-xl px-6 py-3 border-[3px] border-[#000000] shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:translate-y-[1px] hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:translate-y-[2px] active:shadow-none transition-all uppercase flex items-center justify-center gap-2">
                <Icons.Plus className="w-5 h-5" />
                Create Task
              </button>
              <button className="flex-1 md:flex-none bg-[#2a2a2a] text-[#F5F2E8] font-['Work_Sans'] font-bold text-sm uppercase px-6 py-[18px] border-[3px] border-[#555] hover:border-[#F5F2E8] transition-colors flex items-center justify-center gap-2">
                <Icons.X className="w-4 h-4" />
                Cancel
              </button>
            </div>

          </div>
          
          {/* Decorative "Sticker" behind */}
          <div className="absolute -top-4 -right-4 w-full h-full bg-[#00D4FF] border-[3px] border-[#000000] -z-10 transform rotate-2 hidden md:block"></div>
        </div>
      </div>
    );
  };

  return (
    <div className="h-screen bg-[#1E1E1E] flex flex-col font-['Work_Sans']">
      {renderNav()}
      {renderForm()}
      {renderStickyFooter()}
    </div>
  );
};

export default NewTaskFormScreen;