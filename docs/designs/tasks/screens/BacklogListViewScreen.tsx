            import React from "react";
import * as Icons from "lucide-react";

export interface BacklogListViewScreenProps {
  state: string;
}

/**
 * States:
 * - default: Standard list view. Header, search bar visible, task list sorted by priority. Filters collapsed.
 * - filteringActive: Filter bar is expanded/visible, showing active controls. List reflects filtered results.
 * - searchActive: Search bar focused with text. List shows filtered results.
 * - archivedView: "Show Archived" toggle active. List includes grayed/strikethrough archived tasks.
 * - inlineExpanded: One task card expanded (accordion) showing details and read-only metadata.
 * - inlineEditing: One task card expanded and in edit mode with active inputs.
 */
const BacklogListViewScreen: React.FC<BacklogListViewScreenProps> = ({ state }) => {
  
  const expandedId = state === 'inlineExpanded' || state === 'inlineEditing' ? 't2' : null;
  const isArchivedView = state === 'archivedView';

  // --- Render Helpers ---

  const renderMobileNav = () => (
    <div className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#1E1E1E] border-t-[3px] border-[#FFE135] h-16 flex items-center justify-around shadow-[0_-4px_0px_0px_rgba(0,0,0,1)]">
      {/* Backlog Tab */}
      <button className="flex flex-col items-center justify-center w-16 h-full text-[#FFE135]">
        <Icons.LayoutList className="w-6 h-6 mb-1" />
        <span className="text-[10px] font-['Work_Sans'] font-bold uppercase">List</span>
      </button>

      {/* FAB New Task */}
      <button className="relative -top-6 bg-[#FFE135] text-[#1E1E1E] border-[3px] border-[#000000] rounded-full w-14 h-14 flex items-center justify-center shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:scale-105 active:scale-95 transition-transform">
        <Icons.Plus className="w-8 h-8" />
      </button>

      {/* Kanban Tab */}
      <button className="flex flex-col items-center justify-center w-16 h-full text-[#555] hover:text-[#F5F2E8] transition-colors">
        <Icons.LayoutDashboard className="w-6 h-6 mb-1" />
        <span className="text-[10px] font-['Work_Sans'] font-bold uppercase">Board</span>
      </button>
    </div>
  );

  const renderHeader = () => (
    <header className="sticky top-0 z-50 bg-[#1E1E1E] border-b-[3px] border-[#FFE135] px-4 py-3 shadow-lg overflow-hidden relative">
      {/* Chevron Pattern Background */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-16 -left-8 w-48 h-48 bg-[#FFE135] opacity-15" style={{ clipPath: 'polygon(100% 0, 0% 100%, 100% 100%)' }}></div>
        <div className="absolute -top-12 left-1/4 w-40 h-40 bg-[#00D4FF] opacity-12" style={{ clipPath: 'polygon(0 0, 100% 0, 50% 100%)' }}></div>
        <div className="absolute -top-8 left-1/2 w-52 h-52 bg-[#FF3E8A] opacity-10" style={{ clipPath: 'polygon(0 0, 100% 0, 0% 100%)' }}></div>
        <div className="absolute -top-20 right-1/4 w-44 h-44 bg-[#FFE135] opacity-12" style={{ clipPath: 'polygon(100% 0, 0% 100%, 100% 100%)' }}></div>
        <div className="absolute -top-16 -right-12 w-56 h-56 bg-[#00D4FF] opacity-15" style={{ clipPath: 'polygon(0 0, 100% 0, 0% 100%)' }}></div>
        <div className="absolute top-0 -right-20 w-40 h-40 bg-[#FF3E8A] opacity-10" style={{ clipPath: 'polygon(100% 0, 0% 100%, 100% 100%)' }}></div>
      </div>
      
      <div className="relative flex flex-col md:flex-row items-center justify-between gap-3">
        {/* Branding & Mobile Controls */}
        <div className={`flex items-center justify-between w-full md:w-auto transition-all duration-300 ${state === 'searchActive' ? 'opacity-50 scale-95' : ''}`}>
          <div className="flex items-center gap-2 group cursor-pointer">
            <div className="bg-[#FFE135] text-[#1E1E1E] px-2 py-1 border-2 border-[#000000] transform -rotate-2 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">
              <span className="font-['Dela_Gothic_One'] text-xl md:text-2xl tracking-tight uppercase">Pulse</span>
            </div>
          </div>
          
          {/* Mobile Filter Toggle */}
          <button className="md:hidden p-2 bg-[#2a2a2a] border-2 border-[#555] text-[#F5F2E8]">
            <Icons.SlidersHorizontal className="w-5 h-5" />
          </button>
        </div>

        {/* Desktop Controls */}
        <div className="hidden md:flex items-center gap-3 w-full md:w-auto h-[44px]">
          <div className="relative w-64 group h-full">
            <div className="absolute inset-y-0 left-0 pl-2 flex items-center pointer-events-none">
              <Icons.Search className="w-4 h-4 text-[#F5F2E8]" />
            </div>
            <input
              type="text"
              placeholder="SEARCH DECK..."
              value={state === 'searchActive' ? 'graphics' : ''}
              className={`w-full h-full bg-[#2a2a2a] text-[#F5F2E8] pl-9 pr-3 border-2 font-['Work_Sans'] text-sm placeholder-[#CCC] focus:outline-none focus:border-[#00D4FF] focus:shadow-[2px_2px_0px_0px_rgba(0,212,255,0.5)] transition-all ${state === 'searchActive' ? 'border-[#00D4FF]' : 'border-[#555]'}`}
            />
          </div>
          <button className="bg-[#2a2a2a] p-2.5 border-2 border-[#555] hover:border-[#00D4FF] transition-colors h-full items-center justify-center">
            <Icons.LayoutDashboard className="w-5 h-5 text-[#F5F2E8]" />
          </button>
          <button className="bg-[#FFE135] text-[#1E1E1E] font-['Dela_Gothic_One'] px-4 py-2 border-2 border-[#000000] shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] hover:translate-y-[1px] hover:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] active:translate-y-[2px] active:shadow-none transition-all flex items-center justify-center gap-2 uppercase tracking-wide h-full">
            <Icons.Plus className="w-4 h-4" />
            New Task
          </button>
        </div>
      </div>

      {/* Mobile Search Bar */}
      <div className={`mt-3 md:hidden transition-all duration-300 ${state === 'searchActive' ? '-mt-1' : ''}`}>
        <div className={`relative w-full ${state === 'searchActive' ? 'h-12' : 'h-10'}`}>
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Icons.Search className={`${state === 'searchActive' ? 'w-5 h-5' : 'w-4 h-4'} text-[#F5F2E8]`} />
          </div>
          <input
            type="text"
            placeholder={state === 'searchActive' ? 'SEARCH TASKS...' : 'SEARCH...'}
            value={state === 'searchActive' ? 'graphics' : ''}
            className={`w-full h-full bg-[#2a2a2a] text-[#F5F2E8] pl-10 pr-4 border-2 font-['Work_Sans'] ${state === 'searchActive' ? 'text-base' : 'text-sm'} placeholder-[#CCC] focus:outline-none focus:border-[#00D4FF] transition-all ${state === 'searchActive' ? 'border-[#00D4FF] shadow-[0_0_10px_rgba(0,212,255,0.3)]' : 'border-[#555]'}`}
          />
        </div>
      </div>
    </header>
  );

  const renderFilterBar = () => {
    const isFilterVisible = state === 'filteringActive' || state === 'archivedView' || state === 'searchActive';
    
    if (!isFilterVisible) return null;

    return (
      <div className="bg-[#2a2a2a] border-b-2 border-[#555]">
        {/* Desktop Filter Row */}
        <div className="hidden md:flex flex-wrap items-center gap-3 px-4 py-3">
          <select className="bg-[#1E1E1E] text-[#F5F2E8] border-2 border-[#555] px-3 py-1.5 font-['Work_Sans'] text-sm font-bold uppercase focus:outline-none focus:border-[#FFE135]">
            <option>Status: All</option>
            <option>Todo</option>
            <option>Doing</option>
            <option>Done</option>
          </select>
          <select className="bg-[#1E1E1E] text-[#F5F2E8] border-2 border-[#555] px-3 py-1.5 font-['Work_Sans'] text-sm font-bold uppercase focus:outline-none focus:border-[#FFE135]">
            <option>Priority: All</option>
            <option>Urgent</option>
            <option>High</option>
            <option>Medium</option>
            <option>Low</option>
          </select>
          <div className="relative">
            <input type="text" placeholder="Assignee..." className="bg-[#1E1E1E] text-[#F5F2E8] border-2 border-[#555] pl-8 pr-3 py-1.5 font-['Work_Sans'] text-sm placeholder-[#CCC] focus:outline-none focus:border-[#FFE135]" />
            <Icons.User className="absolute left-2 top-2 w-3 h-3 text-[#CCC]" />
          </div>
          <button className={`flex items-center gap-2 px-3 py-1.5 border-2 font-['Work_Sans'] text-sm font-bold uppercase transition-all ${state === 'archivedView' ? 'bg-[#FF3E8A] text-white border-[#000000] shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]' : 'bg-[#1E1E1E] text-[#CCC] border-[#555] hover:border-[#F5F2E8]'}`}>
            <Icons.Trash2 className="w-4 h-4" />
            Show Archived
          </button>
        </div>

        {/* Mobile Filter Chips (Horizontal Scroll) */}
        <div className="md:hidden flex overflow-x-auto whitespace-nowrap px-4 py-2 gap-2 scrollbar-hide justify-start">
          <div className="inline-flex items-center gap-1 bg-[#FFE135] text-[#1E1E1E] border-2 border-[#000000] px-3 py-1 rounded-full text-xs font-bold font-['Work_Sans'] shadow-[1px_1px_0px_0px_rgba(0,0,0,1)]">
            High Priority <Icons.X className="w-3 h-3" />
          </div>
          <div className="inline-flex items-center gap-1 bg-[#00D4FF] text-[#1E1E1E] border-2 border-[#000000] px-3 py-1 rounded-full text-xs font-bold font-['Work_Sans'] shadow-[1px_1px_0px_0px_rgba(0,0,0,1)]">
            Doing <Icons.X className="w-3 h-3" />
          </div>
          <button className="inline-flex items-center gap-1 bg-[#555] text-white border-2 border-[#000000] px-3 py-1 rounded-full text-xs font-bold font-['Work_Sans']">
            <Icons.Plus className="w-3 h-3" /> Add Filter
          </button>
        </div>
      </div>
    );
  };

  const renderPriorityBadge = (level: string, isArchived: boolean) => {
    const baseClasses = "inline-flex items-center gap-1 border-2 border-[#000000] font-['Work_Sans'] font-bold uppercase tracking-wider text-xs px-2 py-1 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] ";
    let colorClass = "";
    
    if (level === 'urgent') colorClass = "bg-[#FF3E8A] text-white";
    else if (level === 'high') colorClass = "bg-[#FFE135] text-black";
    else if (level === 'medium') colorClass = "bg-[#00D4FF] text-black";
    else colorClass = "bg-[#666666] text-white";

    if (isArchived) return <span className={`${baseClasses} bg-[#444] text-[#888] border-[#555] shadow-none`}>Archived</span>;

    return (
      <span className={`${baseClasses} ${colorClass}`}>
        {level === 'urgent' && <Icons.Flame className="w-3 h-3 fill-current" />}
        {level === 'high' && <Icons.Bolt className="w-3 h-3 fill-current" />}
        {level}
      </span>
    );
  };

  const getAvatarColor = (name: string) => {
    const colors: Record<string, string> = {
      'Alex': 'bg-[#FFE135]',
      'Sam': 'bg-[#00D4FF]',
      'Jordan': 'bg-[#FF3E8A]',
    };
    return colors[name] || 'bg-[#666666]';
  };

  const getInitials = (name: string) => name.charAt(0).toUpperCase();

  const renderAvatar = (assignee: string | null, small: boolean = false) => {
    if (!assignee) return null;
    
    const size = small ? 'w-7 h-7 text-sm' : 'w-9 h-9 text-base';
    const rotation = assignee === 'Alex' ? 'rotate-[-2deg]' : assignee === 'Jordan' ? 'rotate-[3deg]' : 'rotate-[-1deg]';
    
    return (
      <div className={`inline-flex items-center justify-center rounded-full border-[3px] border-[#000000] shadow-[2px_2px_0px_0px_rgba(0,0,0,0.3)] font-['Dela_Gothic_One'] font-bold text-[#1E1E1E] ${size} ${getAvatarColor(assignee)} ${rotation}`}>
        {getInitials(assignee)}
      </div>
    );
  };

  const renderTaskCard = (id: string, title: string, priority: string, status: string, assignee: string | null, isExpanded: boolean, isEditing: boolean, isArchived: boolean) => {
    const rotationClass = id === 't1' ? 'rotate-[-0.3deg]' : id === 't2' ? 'rotate-[0.3deg]' : 'rotate-[-0.2deg]';
    const isExpandedState = expandedId === id;

    return (
      <div
        className={`
          relative bg-[#F5F2E8] border-[3px] border-[#000000] p-4 mb-4 cursor-pointer
          ${rotationClass}
          shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]
          hover:-translate-y-1 hover:shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] transition-all duration-200
          ${isArchived ? 'opacity-60 grayscale' : ''}
          ${isExpandedState ? 'z-10 ring-4 ring-[#00D4FF] rotate-0 shadow-none hover:shadow-none hover:translate-y-0' : ''}
          ${isExpandedState ? 'md:static md:z-10 md:ring-4 md:ring-[#00D4FF] md:rotate-0 md:shadow-none md:hover:shadow-none md:hover:translate-y-0' : ''}
          ${isExpandedState ? 'fixed inset-x-4 top-20 bottom-20 md:bottom-auto md:top-auto md:inset-auto md:relative overflow-y-auto' : ''}
        `}
      >
        <div className="flex justify-between items-start mb-2">
          <h3 className={`font-['Work_Sans'] font-bold leading-tight text-lg md:text-base ${isArchived ? 'line-through text-[#555]' : 'text-[#1E1E1E]'}`}>
            {title}
          </h3>
          <button className="text-[#1E1E1E] opacity-30 hover:opacity-100 hover:bg-[#FFE135] p-1 rounded transition-colors">
            <Icons.ChevronsUpDown className="w-5 h-5" />
          </button>
        </div>

        <div className="flex items-center gap-2 mb-2">
          {renderPriorityBadge(priority, isArchived)}
          <span className={`text-[10px] font-['Work_Sans'] uppercase tracking-wider ${isArchived ? 'text-[#888]' : 'text-[#666]'}`}>
            {status}
          </span>
        </div>

        {(isExpandedState || isExpanded) && (
          <>
            {/* Mobile Close Handle */}
            <div className="md:hidden flex justify-center mb-4">
              <div className="w-12 h-1 bg-[#000000] rounded-full"></div>
            </div>
            <div className="mt-3 pt-3 border-t-2 border-dashed border-[#000000]">
            {isEditing ? (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-bold font-['Work_Sans'] uppercase text-[#666] mb-1">Title</label>
                  <input type="text" defaultValue={title} className="w-full bg-white border-2 border-[#000000] p-2 font-['Work_Sans'] text-sm focus:outline-none focus:border-[#00D4FF]" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-bold font-['Work_Sans'] uppercase text-[#666] mb-1">Status</label>
                    <select className="w-full bg-white border-2 border-[#000000] p-2 font-['Work_Sans'] text-sm focus:outline-none focus:border-[#00D4FF]">
                      <option>Todo</option>
                      <option>Doing</option>
                      <option>Done</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-bold font-['Work_Sans'] uppercase text-[#666] mb-1">Priority</label>
                    <select className="w-full bg-white border-2 border-[#000000] p-2 font-['Work_Sans'] text-sm focus:outline-none focus:border-[#00D4FF]">
                      <option>Urgent</option>
                      <option>High</option>
                      <option>Medium</option>
                      <option>Low</option>
                    </select>
                  </div>
                </div>
                <div className="flex justify-end gap-2 mt-2 pb-2">
                  <button className="px-4 py-2 text-sm font-bold font-['Dela_Gothic_One'] uppercase bg-[#FFE135] text-[#1E1E1E] border-2 border-[#000000] shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:translate-y-[1px]">Save</button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="font-['Work_Sans'] text-sm text-[#333]">
                  Detailed description of the task goes here. Check the inventory and verify the shipment numbers against the manifest.
                </p>
                <div className="flex gap-2">
                  <span className="bg-[#00D4FF] text-[#1E1E1E] text-[11px] font-bold font-['Work_Sans'] px-2.5 py-1 border border-[#000000] inline-block transform -rotate-1">Logistics</span>
                </div>
                <div className="flex justify-between items-center pt-3 mt-3 border-t border-dashed border-[#000000]">
                  {renderAvatar('Alex')}
                  <div className="flex gap-2">
                    {isArchived ? (
                      <button className="text-xs font-['Dela_Gothic_One'] font-bold uppercase bg-[#FFE135] text-[#1E1E1E] px-3 py-1.5 border-2 border-[#000000] shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] hover:translate-y-[1px]">Un-archive</button>
                    ) : (
                      <>
                        <button className="text-xs font-['Dela_Gothic_One'] font-bold uppercase bg-[#FFE135] text-[#1E1E1E] px-3 py-1.5 border-2 border-[#000000] shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] hover:translate-y-[1px]">Edit</button>
                        <button className="text-xs font-['Dela_Gothic_One'] font-bold uppercase bg-[#FF3E8A] text-white px-3 py-1.5 border-2 border-[#000000] shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] hover:translate-y-[1px]">Archive</button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-[#1E1E1E] flex flex-col font-['Work_Sans']">
      {renderHeader()}
      {renderFilterBar()}

      <main className="flex-1 p-4 md:p-6 max-w-5xl mx-auto w-full pb-20 md:pb-6">
        <div className="space-y-2">
          {/* Task 1 */}
          {state !== 'searchActive' && renderTaskCard('t1', 'Finalize Q4 Budget Report', 'urgent', 'todo', 'Alex', false, false, false)}

          {/* Task 2 */}
          {renderTaskCard('t2', 'Update Skateboard Deck Graphics', 'high', 'doing', 'Jordan', state === 'inlineExpanded' || state === 'inlineEditing', state === 'inlineEditing', false)}

          {/* Task 3 */}
          {state !== 'searchActive' && renderTaskCard('t3', 'Contact Wheel Supplier', 'medium', 'todo', 'Sam', false, false, false)}

          {/* Task 4 */}
          {state !== 'searchActive' && renderTaskCard('t4', 'Archive Old Photos', 'low', 'done', null, false, false, false)}

          {/* Archived Task - expanded by default in archivedView */}
          {state === 'archivedView' && renderTaskCard('t5', 'Old Task From 2023', 'low', 'done', null, true, false, true)}
        </div>
      </main>
      
      {renderMobileNav()}
    </div>
  );
};

export default BacklogListViewScreen;
